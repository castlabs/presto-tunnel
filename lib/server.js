const {hri} = require('human-readable-ids');
const WebSocketServer = require('websocket').server;
const http = require('http');
const url = require('url');
const debug = require('debug')('tl:server')
const {v4: uuidv4} = require('uuid');
const stream = require("stream");
const pump = require("pump");

function createTunnelName() {
    return hri.random();
}

class WsStream extends stream.Duplex {
    constructor(ws, id) {
        super();
        this.ws = ws;
        this.debug = require('debug')('tl:stream:' + id);
        this.endHandler = this.handleWsEnd_.bind(this);
        this.closeHandler = this.handleWsClose_.bind(this);
        this.errorHandler = this.handleWsError_.bind(this);
        this.messageHandler = this.handleWsMessage_.bind(this);
        this._open = true;
        this.bound = false;
        this.bind()
    }

    bind() {
        this.ws.on('message', this.messageHandler);
        this.ws.on('end', this.endHandler);
        this.ws.on('close', this.closeHandler);
        this.ws.on('error', this.errorHandler);
        this.bound = true;
    }

    unbind() {
        this.ws.off('message', this.messageHandler);
        this.ws.off('end', this.endHandler);
        this.ws.off('close', this.closeHandler);
        this.ws.off('error', this.errorHandler);
        this.bound = false;
    }

    handleWsEnd_() {
        this.debug('Stream end');
        this._open = false;
        this.unbind();
        return this.emit('end');
    }

    handleWsClose_() {
        this.debug('Stream closed');
        this._open = false;
        this.unbind();
        return this.emit('close');
    }

    handleWsError_(err) {
        this.debug('Error on stream', err);
        this._open = false;
        this.unbind();
        this.emit('error', err);
    }

    handleWsMessage_(message) {
        if (message.type === 'utf8') {
            if (message.utf8Data === 'END') {
                this.debug('Received stop! Closing connection.');
                this.end()
            } else {
                this.debug('Do not know how to handle message: ' + message.utf8Data);
            }
        } else if (message.type === 'binary') {
            // this.debug('Pushing ' + message.binaryData.length + ' bytes upstream to HTTP');
            return this.push(message.binaryData);
        }
    }

    end() {
        super.end();
        // emit an end event but make sure that we are NOT closing the WS socket since
        // we want to reuse that one.
        this.debug('Closing connection.');
        this.unbind();
        this.emit('end')
    }

    stop() {
        if (this._open && this.bound) {
            this.ws.sendUTF('END');
            this.end();
        }
    }

    // node stream overrides
    // @push is called when there is data, _read does nothing
    _read() {
    }

    // if callback is not called, then stream write will be blocked
    _write(chunk, encoding, callback) {
        if (this._open) {
            // this.debug('Send ' + chunk.length + ' bytes downstream through WS');
            return this.ws.sendBytes(chunk, callback);
        } else {
            this.debug('Can not write data. Stream no open.')
        }
    }
}

// Implements an http.Agent interface to a pool of tunnel sockets
// A tunnel socket is a connection _from_ a client that will
// service http requests. This agent is usable wherever one can use an http.Agent
class TunnelAgent extends http.Agent {
    constructor(tunnelName) {
        super({
            keepAlive: false,
            // only allow keepalive to hold on to one socket
            // this prevents it from holding on to all the sockets so they can be used for upgrades
            maxFreeSockets: 1,
        });
        this.tunnelName = tunnelName;
        this.debug = require('debug')(`tl:agent:${tunnelName}`);
        this.availableSockets = [];
        this.waitingCreateConn = [];
        this.openConnections = 0;
        this.closed = false;
        this.graceCloseTimeout = null;
    }

    addConnection(connection) {
        this.handleConnectionAvailable(connection);
    }

    removeConnection(connection) {
        connection.close()
        let i = this.availableSockets.indexOf(connection);
        if (i >= 0) {
            this.availableSockets.splice(i, 1)
        } else {
            this.openConnections -= 1;
        }
        debug('Connection to client closed. Removing connection. Available connections: %d Open connections %d', this.availableSockets.length, this.openConnections);
        if (this.availableSockets.length === 0 && this.openConnections === 0) {
            this.emit('no-connections');
        }
    }

    createConnection(options, cb) {
        if (this.closed) {
            this.debug('Agent closed. Can not create connections.');
            cb(new Error('closed'));
            return;
        }
        options = options || {};

        // socket is a tcp connection back to the user hosting the site
        const sock = this.availableSockets.shift();

        // no available sockets, put this connection request to the wait list
        if (!sock) {
            this.waitingCreateConn.push({callback: cb, options: options});
            this.debug('No connection available. Putting request to waiting connections: %s', this.waitingCreateConn.length);
            return;
        }

        const stream = new WsStream(sock, this.tunnelName);
        this.openConnections += 1;
        this.debug('Created stream. Available connections left %s. Open connections %d', this.availableSockets.length, this.openConnections);

        if (!options.ignoreEndEvent) {
            this.debug('Attaching internal end listener')
            stream.once('end', () => {
                this.debug('Received end event. Making connection available.');
                this.openConnections -= 1;
                this.handleConnectionAvailable(sock);
                stream.removeAllListeners();
            });
        }
        cb(null, stream);
    }

    handleConnectionAvailable(connection) {
        clearTimeout(this.graceCloseTimeout);

        const fn = this.waitingCreateConn.shift();
        if (fn) {
            setTimeout(() => {
                this.debug('Connections available: %s open connections %s. Processing waiting connection.', this.availableSockets.length, this.openConnections);
                this.availableSockets.push(connection);
                this.createConnection(fn.options, fn.callback)
            }, 0);
        } else {
            this.availableSockets.push(connection);
            this.debug('Connections available: %s open connections %s', this.availableSockets.length, this.openConnections);
        }
    }

    destroy() {
        super.destroy();
        for (const conn of this.waitingCreateConn) {
            conn.callback(new Error('destroyed'), null);
        }
        this.waitingCreateConn = [];
    }
}

function findTunnelByName(tunnels, name) {
    for (const id in tunnels) {
        let tunnel = tunnels[id];
        if (tunnel.tunnelName === name) {
            return tunnel;
        }
    }
    return null;
}

function startConnectionGraceTimeout(tunnels, tunnelId, tunnelAgent, tunnelName) {
    let tunnel = tunnels[tunnelId];
    if(!tunnel) return;
    debug('Staring tunnel close timeout for ' + tunnelName);
    tunnels[tunnelId].agent.graceCloseTimeout = setTimeout(() => {
        if (tunnelAgent.availableSockets.length === 0 && tunnelAgent.openConnections === 0) {
            debug('No connections available for ' + tunnelName + ' after grace period. Deleting tunnel');
            tunnelAgent.destroy();
            delete tunnels[tunnelId];
        }
    }, 5000)
}

function startServer(serverName, port, tunnelScheme, subDomains = false) {
    const tunnels = {};
    const tunnelNameSeparator = subDomains ? '.' : '-';

    function findTunnel(hostName) {
        let name = hostName.replace(serverName, '');
        name = name.substr(0, name.length - 1);
        for (const id in tunnels) {
            let t = tunnels[id];
            if (t.tunnelName === name) {
                return t;
            }
        }
        return null;
    }

    const server = http.createServer(function (req, res) {
        const parsed = url.parse(req.url, true);
        const hostName = req.headers.host.split(":")[0];

        debug(`HTTP request received ${hostName}${req.url}`);
        let preferredTunnelName = parsed.query['new'];
        if (hostName === serverName && parsed.pathname === '/' && (preferredTunnelName === '' || preferredTunnelName)) {
            const tunnelId = uuidv4();
            let tunnelName = createTunnelName();
            if (preferredTunnelName && findTunnelByName(tunnels, preferredTunnelName) === null) {
                tunnelName = preferredTunnelName;
            }

            const tunnelUrl = `${tunnelScheme}://${tunnelName}${tunnelNameSeparator}${serverName}`;
            const maxSlots = 2; // TODO: Make this configurable
            const tunnelAgent = new TunnelAgent(tunnelName);
            tunnels[tunnelId] = {
                tunnelId,
                tunnelName,
                tunnelUrl,
                maxSlots,
                agent: tunnelAgent
            }
            tunnelAgent.on('no-connections', () => {
                startConnectionGraceTimeout(tunnels, tunnelId, tunnelAgent, tunnelName);
            })
            startConnectionGraceTimeout(tunnels, tunnelId, tunnelAgent, tunnelName);

            debug('Create new tunnel connection to ' + tunnelUrl)
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                tunnelUrl, tunnelName, tunnelId, maxSlots
            }));
        } else if (hostName !== serverName) {

            let t = findTunnel(hostName);
            if (!t) {
                debug(`Tunnel for ${hostName} not found!`);
                res.writeHead(404);
                res.end()
                return;
            }

            const options = {
                agent: t.agent,
                path: req.url,
                method: req.method,
                headers: req.headers
            };
            let proxy = http.request(options, function (proxy_response) {
                // write response code and headers
                res.writeHead(proxy_response.statusCode, proxy_response.headers);
                // using pump is deliberate - see the pump docs for why
                pump(proxy_response, res);
            });
            req.socket.once('close', () => {
                let s = proxy.socket;
                if (s && s._open && s.bound) {
                    debug('Request socket closed. Stopping proxy request.');
                    s.stop();
                }
            })
            req.socket.once('error', (err) => {
                let s = proxy.socket;
                if (s && s._open && s.bound) {
                    debug('Error on request socket', err);
                    s.stop();
                }
            });

            pump(req, proxy);
        }
    });

    server.listen(port, () => {
        debug(`Server started on ${port}`);
    });

    const wsServer = new WebSocketServer({
        httpServer: server,
        noServer: true
    });

    wsServer.on('request', function (request) {
        const parsed = url.parse(request.httpRequest.url, true);
        const hostName = request.httpRequest.headers.host.split(":")[0];
        debug(`WS request received ${hostName}${request.httpRequest.url}`);
        if (hostName !== serverName) {
            let tunnel = findTunnel(hostName);
            if (!tunnel) {
                debug(`Tunnel for ${hostName} not found!`);
                request.reject(404);
                return;
            }
            let alreadyClosed = false;
            function handleRequestTerminationBeforeConnection () {
                debug('Request socket terminated!');
                alreadyClosed = true;
            }

            const earlyTerminationHandler = handleRequestTerminationBeforeConnection.bind(this);
            request.socket.once('end', earlyTerminationHandler);

            tunnel.agent.createConnection({ignoreEndEvent: true}, (err, stream) => {
                request.socket.removeListener('end', earlyTerminationHandler);
                if (err) {
                    debug('Error while creating connection:', err);
                    return;
                }
                if(alreadyClosed) {
                    debug('Source WS connection already closed!');
                    stream.stop();
                    tunnel.agent.openConnections -= 1;
                    tunnel.agent.handleConnectionAvailable(stream.ws);
                    // stream.ws.close();
                    // stream.removeAllListeners();
                    return;
                }
                debug('Establish connection', alreadyClosed);

                request.socket.once('close', function() {
                   stream.stop();
                });
                request.socket.once('error', function(err) {
                    debug('Error on client connection for', tunnel.tunnelName, err);
                   stream.stop();
                });
                let req = request.httpRequest;
                const arr = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
                for (let i = 0; i < (req.rawHeaders.length - 1); i += 2) {
                    arr.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
                }
                arr.push('');
                arr.push('');

                stream.once('end', () => {
                    debug('WS Forward connection closed. Closing WS connection.');
                    stream.ws.close();
                    stream.removeAllListeners();
                })
                // using pump is deliberate - see the pump docs for why
                pump(stream, req.socket);
                pump(req.socket, stream);
                stream.write(arr.join('\r\n'));
            });

            return;
        }
        if (parsed.pathname !== '/connect' || !tunnels[parsed.query['id']]) {
            debug(`Rejecting connection with pathname ${parsed.pathname} and id ${parsed.query['id']}`)
            request.reject();
            return;
        }
        const tunnel = tunnels[parsed.query['id']];

        debug(`Establish connection for tunnel: ${tunnel.tunnelName}`);
        const connection = request.accept('tunnel-protocol', request.origin);
        connection.on('error', function (err) {
            debug('Connection Error on ' + tunnel.tunnelName, err.toString())
            connection.close();
        });

        connection.on('close', function () {
            tunnel.agent.removeConnection(connection);
        });
        debug('Adding connection and making it available.');
        tunnel.agent.addConnection(connection);
    });
}

exports.startServer = startServer;