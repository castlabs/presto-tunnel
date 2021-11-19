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
        this.closeHandler = this.handleWsClose_.bind(this);
        this.errorHandler = this.handleWsError_.bind(this);
        this.messageHandler = this.handleWsMessage_.bind(this);
        this._open = true;
        this.bound = false;
        this.bind()
    }

    bind() {
        this.ws.on('message', this.messageHandler);
        this.ws.on('close', this.closeHandler);
        this.ws.on('error', this.errorHandler);
        this.bound = true;
    }

    unbind() {
        this.ws.off('message', this.messageHandler);
        this.ws.off('close', this.closeHandler);
        this.ws.off('error', this.errorHandler);
        this.bound = false;
    }

    handleWsClose_() {
        this.debug('Stream closed');
        this._open = false;
        return this.emit('close');
    }

    handleWsError_(err) {
        this.debug('Error on stream', err);
        this.emit('error', err);
    }

    handleWsMessage_(message) {
        if (message.type === 'utf8') {
            this.debug('Received Message: ' + message.utf8Data);
            return this.push(message.utf8Data);
        } else if (message.type === 'binary') {
            this.debug('Received Binary Message of ' + message.binaryData.length + ' bytes');
            return this.push(message.binaryData);
        }
    }

    end() {
        super.end();
        // emit an end event but make sure that we are NOT closing the WS socket since
        // we want to reuse that one.
        this.debug('WS Connection end event.');
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
            this.debug('Writing data to stream. ' + chunk.length + ' bytes with encoding: ' + encoding);
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
            keepAlive: true,
            // only allow keepalive to hold on to one socket
            // this prevents it from holding on to all the sockets so they can be used for upgrades
            maxFreeSockets: 1,
        });
        this.tunnelName = tunnelName;
        this.debug = require('debug')(`tl:agent:${tunnelName}`);
        this.availableSockets = [];
        this.waitingCreateConn = [];
        this.closed = false;
    }

    addConnection(connection) {
        this.handleConnectionAvailable(connection);
    }

    removeConnection(connection) {
        //delete tunnels[tunnel.tunnelId];
        connection.close()
        let i = this.availableSockets.indexOf(connection);
        if (i >= 0) {
            this.availableSockets.splice(i, 1)
        }
        debug('Connection to client closed. Removing connection. Available connections: ' + this.availableSockets.length);
        if (this.availableSockets.length === 0) {
            this.emit('no-connections');
        }
    }

    createConnection(options, cb) {
        if (this.closed) {
            this.debug('Agent closed. Can not create connections.');
            cb(new Error('closed'));
            return;
        }

        // socket is a tcp connection back to the user hosting the site
        const sock = this.availableSockets.shift();
        // no available sockets, put this connection request to the wait list
        if (!sock) {
            this.waitingCreateConn.push(cb);
            this.debug('No connection available. Putting request to waiting connections: %s', this.waitingCreateConn.length);
            return;
        }
        this.debug('Creating stream for available connection. Available connections left %s', this.availableSockets.length);
        const stream = new WsStream(sock, this.tunnelName);
        stream.once('end', () => {
            this.handleConnectionAvailable(sock)
        });
        cb(null, stream);
    }

    handleConnectionAvailable(connection) {
        const fn = this.waitingCreateConn.shift();
        if (fn) {
            setTimeout(() => {
                this.debug('Connections available: %s. Processing waiting connection.', this.availableSockets.length);
                this.availableSockets.push(connection);
                this.createConnection({}, fn)
            }, 0);
        } else {
            this.availableSockets.push(connection);
            this.debug('Connections available: %s', this.availableSockets.length);
        }
    }

    destroy() {
        super.destroy();
        for (const conn of this.waitingCreateConn) {
            conn(new Error('destroyed'), null);
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

function startServer(serverName, port, tunnelScheme, subDomains = false) {
    const tunnels = {};
    const tunnelNameSeparator = subDomains ? '.' : '-';

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
            const maxSlots = 10; // TODO: Make this configurable
            const tunnelAgent = new TunnelAgent(tunnelName);
            tunnels[tunnelId] = {
                tunnelId,
                tunnelName,
                tunnelUrl,
                maxSlots,
                agent: tunnelAgent
            }
            tunnelAgent.on('no-connections', () => {
                tunnels[tunnelId].graceCloseTimeout = setTimeout(() => {
                    if (tunnelAgent.availableSockets.length === 0) {
                        debug('No connections available for ' + tunnelName + ' after grace period. Deleting tunnel');
                        tunnelAgent.destroy();
                        delete tunnels[tunnelId];
                    }
                }, 5000)
            })

            debug('Create new tunnel connection to ' + tunnelUrl)
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                tunnelUrl, tunnelName, tunnelId, maxSlots
            }));
            return;
        } else if (hostName !== serverName) {
            // check if the host name patches a session
            let name = hostName.replace(serverName, '');
            name = name.substr(0, name.length - 1);
            for (const id in tunnels) {
                let t = tunnels[id];
                if (t.tunnelName === name) {
                    debug(`Found matching session. Forwarding request.`);
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
                        if (s._open && s.bound) {
                            debug('Request socket closed. Stopping proxy request.');
                            s.stop();
                        }
                    })
                    req.socket.once('error', (err) => {
                        let s = proxy.socket;
                        if (s._open && s.bound) {
                            debug('Error on request socket', err);
                            s.stop();
                        }
                    });

                    pump(req, proxy);
                    return;
                }
            }
        }
        res.writeHead(404);
        res.end()
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
        if (parsed.pathname !== '/connect' || !tunnels[parsed.query['id']]) {
            debug(`Rejecting connection with pathname ${parsed.pathname} and id ${parsed.query['id']}`)
            request.reject();
            return;
        }
        const tunnel = tunnels[parsed.query['id']];

        debug(`Establish connection for tunnel: ${tunnel.tunnelName}`);
        const connection = request.accept('tunnel-protocol', request.origin);
        connection.on('error', function (err) {
            debug('Connection Error. Removing tunnel ' + tunnel.tunnelName, err)
            delete tunnels[tunnel.tunnelId];
        });

        connection.on('close', function () {
            tunnel.agent.removeConnection(connection);
        });
        tunnel.agent.addConnection(connection);
    });
}

exports.startServer = startServer;