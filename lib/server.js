const {hri} = require('human-readable-ids');
const WebSocketServer = require('websocket').server;
const http = require('http');
const url = require('url');
const {v4: uuidv4} = require('uuid');
const pump = require("pump");
const ServerConnection = require("./streams").ServerConnection
const WebSocketConnection = require('websocket').connection;

/**
 * Creates a random human readable name for a tunnel
 *
 * @returns {string}
 */
function createTunnelName() {
    return hri.random();
}

/**
 * The tunnel maintains a list of web socket connections from the client. The tunnel
 * can then handle incoming http requests and use the connections to forward the connections.
 * The connections are kept open as long as possible and can be reused for normal
 * http requests. For forwarded websockets, the connections are ended by the
 * wrapped socket and can not be re-used but the client will re-establish the connection
 * after its termination.
 *
 * WebSocket connections that are added to the tunnel are owned by the tunnel. The tunnel
 * might decide to close and terminate connections and will register listeners to
 * monitor the sockets life cycle.
 *
 * This class extends the http.Agent in order to handle http requests directly. For that
 * the createConnection method is called and creates a stream from an available connection.
 */
class Tunnel extends http.Agent {
    constructor(id, name, url, maxSlots, hostname) {
        super({
            keepAlive: false,
            maxFreeSockets: 1,
        });

        /**
         * Unique uuid of this tunnel
         */
        this.id = id;
        /**
         * human readable name of this tunnel
         */
        this.name = name;
        /**
         * The url of this tunnel
         */
        this.url = url;
        /**
         * Max slots that are offered by this tunnel
         */
        this.maxSlots = maxSlots;
        /**
         * The connections that are available to this tunnel.
         *
         * We are using a fixed size array for the slots and a null
         * value indicates that the slot is free.
         *
         * @type {ServerConnection[]}
         */
        this.connections = new Array(this.maxSlots).fill(null);
        /**
         * Debug logger
         *
         * @private
         */
        this._debug = require('debug')('tl:tunnel:' + name);
        /**
         * Waiting connection requests
         *
         * @type {{callback: function, options: Object}[]}
         * @private
         */
        this._waitingConnectionRequests = [];
        /**
         * The host name that will be injected when forwarding requests
         * @private
         */
        this._hostname = hostname;
    }

    /**
     * Returns the current connection status stats. This covers the
     * total number of connections, the number of connected connections,
     * the number of connections that are available for use, and the
     * number of free slots.
     *
     * @returns {{connected: number, total: number, waiting: number, available: number, free: number}}
     */
    connectionStatus() {
        let total = this.connections.length;
        let available = 0;
        let connected = 0;
        let waiting = this._waitingConnectionRequests.length;
        let free = 0;
        for (let i = 0; i < this.connections.length; i++) {
            let connection = this.connections[i];
            if (!connection) {
                free++;
            } else {
                if (connection.connected()) {
                    connected++;
                } else {
                    available++;
                }
            }
        }
        return {total, available, connected, free, waiting};
    }

    /**
     * Helper that returns the connection status as a string for logging purposes.
     *
     * @returns {string} The connection status string
     * @private
     */
    _connectionStatusString() {
        let {total, available, connected, free, waiting} = this.connectionStatus();
        return `Status: ${total} slots ${available} available ${connected} connected ${free} free ${waiting} waiting`;
    }

    /**
     * Find a free slot or return -1
     *
     * @returns {number} The index of a free slot or -1
     * @private
     */
    _findEmptySlot() {
        for (let i = 0; i < this.connections.length; i++) {
            if (this.connections[i] == null) return i;
        }
        return -1;
    }

    /**
     * Find the index of a given connection or return -1.
     *
     * @param {ServerConnection} connection The connection
     * @returns {number} The index of the slot in the slot array or -1
     * @private
     */
    _findSlotByConnection(connection) {
        for (let i = 0; i < this.connections.length; i++) {
            if (this.connections[i] === connection) return i;
        }
        return -1;
    }

    /**
     * Find a stream that is not yet connected
     *
     * @returns {null|ServerConnection}
     * @private
     */
    _findAvailableConnection() {
        for (let i = 0; i < this.connections.length; i++) {
            if (this.connections[i] && !this.connections[i].connected()) return this.connections[i];
        }
        return null;
    }

    /**
     * Returns a listener that can be attached to a web socket and will
     * remove the connection when triggered.
     *
     * @param {ServerConnection} connection The connection
     * @returns {(function(): void)|*} The listener function
     * @private
     */
    _connectionTerminateListener(connection) {
        return () => {
            this.removeConnection(connection);
        }
    }

    /**
     * Removes a waiting connection request identified by its callback function
     *
     * @param callback The callback function
     */
    removeWaitingConnectionRequest(callback) {
        let idx = -1;
        for (let i = 0; i < this._waitingConnectionRequests.length; i++) {
            if (this._waitingConnectionRequests[i].callback === callback) {
                idx = i;
                break;
            }
        }
        if (idx >= 0) {
            this._waitingConnectionRequests.splice(idx, 1);
            this._debug('Removed waiting connection request. ' + this._connectionStatusString());
        }
    }

    /**
     * Removes the given connection and frees a slot
     *
     * @param {ServerConnection} connection The connection
     */
    removeConnection(connection) {
        let idx = this._findSlotByConnection(connection);
        if (idx < 0) {
            this._debug('Connection not found in slots.');
            return;
        }
        // noinspection JSUnresolvedFunction
        connection.removeAllListeners();
        connection.end()
        this.connections[idx] = null;
        this._debug('Removed connection [' + idx + ']. ' + this._connectionStatusString());
        this.emit('connection-removed');
    }

    /**
     * Adds the given connection to this tunnel.
     *
     * @param {WebSocketConnection} wsConnection The connection
     * @returns {boolean} True if the connection was accepted
     */
    addConnection(wsConnection) {
        let idx = this._findEmptySlot()
        if (idx < 0) {
            this._debug('Connection rejected. ' + this._connectionStatusString());
            return false;
        }

        // Create a new connection from the given websocket connection
        // and attach all listeners that we need on that connection
        let connection = new ServerConnection(wsConnection, `${this.name}[${idx}]`);
        connection.on('close', this._connectionTerminateListener(connection));
        connection.on('error', this._connectionTerminateListener(connection));
        connection.on('end', this._connectionTerminateListener(connection));
        connection.on('disconnected', () => {
            this._debug(`${connection.id} stream disconnected. ${this._connectionStatusString()}`);
            this._processWaitingConnectionRequests();
        });

        this.connections[idx] = connection;
        this._debug('Added connection [' + idx + ']. ' + this._connectionStatusString());
        this._processWaitingConnectionRequests();
        this.emit('connection-added');
        return true;
    }

    /**
     * Processes the next available connection and tries to schedule it if a
     * slot is available.
     *
     * Note that this only processes one waiting connection and is expected to
     * be called whenever a connection becomes available.
     *
     * @private
     */
    _processWaitingConnectionRequests() {
        const status = this.connectionStatus();
        if (this._waitingConnectionRequests.length > 0 && status.available > 0) {
            let waitingConnectionRequest = this._waitingConnectionRequests.shift();
            if (waitingConnectionRequest) {
                this._debug('Processing waiting connection request');
                this.createConnection(waitingConnectionRequest.options, waitingConnectionRequest.callback);
            }
        }
    }

    // overwrite the http.agents createConnection
    createConnection(options, cb) {
        // Try to find an available connection. If none is found, we add the request to the
        // waiting list.
        const connection = this._findAvailableConnection();
        if (connection == null) {
            this._waitingConnectionRequests.push({callback: cb, options: options});
            this._debug('No connection available. ' + this._connectionStatusString());
            return;
        }

        // create a stream from the connection
        let stream = connection.connect(options.closeWebsocket);
        if (stream == null) {
            cb(new Error('Stream not available'));
            return;
        }
        this._debug(`${connection.id} stream connected. ${this._connectionStatusString()}`);
        cb(null, stream);
    }

    destroy() {
        super.destroy();
        this._debug('Destroying tunnel and closing waiting connection requests');
        // make sure that when we destroy the tunnel, all connections are closed and
        // all waiting connections are terminated
        for (let i = 0; i < this.connections.length; i++) {
            let connection = this.connections[i];
            if (connection != null) {
                // noinspection JSUnresolvedFunction
                connection.removeAllListeners();
                connection.end()
                this.connections[i] = null;
            }
        }
        for (const conn of this._waitingConnectionRequests) {
            conn.callback(new Error('destroyed'), null);
        }
        this._waitingConnectionRequests = [];
    }

    /**
     * Handle an http request that is forwarded through though tunnel.
     *
     * @param req The request
     * @param res The response
     */
    handleHttpRequest(req, res) {
        // If specified, overwrite the host header of the request
        if (this._hostname) {
            req.headers['Host'] = this._hostname;
        }
        // We are using a proxy request here. Most importantly
        // this is passed as the agent to the request options to
        // make sure that the tunnel is used to create the connection.
        const options = {
            agent: this,
            path: req.url,
            method: req.method,
            headers: req.headers
        };
        const requestId = uuidv4();
        // Create the proxy request, write the header and then pump the data.
        // We are using pump here to make sure that the connection is ended properly
        // when done.
        let proxy = http.request(options, function (proxy_response) {
            proxy.socket.sendResponse(requestId, req, proxy_response);
            res.writeHead(proxy_response.statusCode, proxy_response.headers);
            // forward the results
            pump(proxy_response, res);
        });
        proxy.on('socket', (s) => {
            s.setRequestId(requestId, {
                method: req.method,
                path: req.url
            });
        })
        proxy.on('error', (err) => {
            this._debug(`proxy connection error ${err.message}. Closing request.`,);
            res.socket.destroy();
        });
        // we need to listen to the request and make sure that we handle
        // termination properly. The socket of the proxy is our own stream
        // and we expose a stop method that makes sure that the connection
        // is terminated.
        req.socket.once('close', () => {
            let s = proxy.socket;
            if (s && s._open) {
                this._debug('Request socket closed. Stopping proxy request.');
                s.stop();
            }
        })
        req.socket.once('error', (err) => {
            let s = proxy.socket;
            if (s && s._open) {
                this._debug('Error on request socket', err);
                s.stop();
            }
        });
        // forward the request data. Pump is used to make sure that
        // the connection is ended accordingly
        pump(req, proxy);
    }

    handleWebSocketRequest(request) {
        // Create the callback reference here since we need it further below
        // when we want to terminate the connection.
        let cb;
        // make sure that we are listening to the end even on the socket until the
        // connection is established. In case we have no free socket, we might wait for
        // an available slot. In case the connection is terminated.
        let alreadyClosed = false;
        let onRequestTerminated = () => {
            this._debug('Request socket terminated');
            alreadyClosed = true;
            this.removeWaitingConnectionRequest(cb);
        }
        request.socket.once('end', onRequestTerminated);

        // the callback that is triggered when the stream is available.
        // we need to create this here so that we have a reference that we can try to
        // remove from the waiting connection requests in case the request is terminated
        // early
        cb = (err, stream) => {
            // we have a connected stream
            request.socket.removeListener('end', onRequestTerminated);

            let requestId = uuidv4();
            stream.setRequestId(requestId, {
                method: 'SOCKET',
                path: request.httpRequest.url
            });
            request.socket.on('end', () => {
                stream.sendResponse(requestId, {
                    method: 'SOCKET',
                    url: request.httpRequest.url
                }, {
                    statusCode: ''
                });
            });


            if (err) {
                // log this only if the message is not destroyed, which means that the
                // underlying tunnel does not exist anymore
                if (err.message !== 'destroyed') {
                    this._debug('Error while creating connection:', err.message);
                }
                request.socket.end();
                return;
            }

            // This is here just in case and should not happen. If the
            // connection was already terminated the request should have been
            // removed from the waiting list. That avoids that the stream is
            // terminated. If we get here though, we end the stream and return.
            // This will terminate the web socket.
            if (alreadyClosed) {
                this._debug('Source connection already closed');
                stream.end()
                return;
            }
            // we need to listen to termination on the
            // request and make sure that we terminate the stream accordingly
            request.socket.once('close', () => {
                stream.stop();
            });
            request.socket.once('error', (err) => {
                this._debug('Error on client connection for', this.name, err);
                stream.stop();
            });

            // we are avoiding another http proxy here and simply
            // re-write the headers to the request before we start pumping
            const req = request.httpRequest;
            const arr = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            for (let i = 0; i < (req.rawHeaders.length - 1); i += 2) {
                let header = req.rawHeaders[i];
                if (header.toLowerCase() === 'host' && this._hostname) {
                    arr.push(`${header}: ${this._hostname}`);
                } else {
                    arr.push(`${header}: ${req.rawHeaders[i + 1]}`);
                }
            }
            arr.push('');
            arr.push('');

            // Start forwarding the data between the tunnel stream and the request
            // and use pump here to make sure that the sides are terminated accordingly
            pump(stream, req.socket);
            pump(req.socket, stream);
            // start writing by writing the headers
            stream.write(arr.join('\r\n'));
        };

        // since we are not creating a proxy request we have to use the
        // the http.agent createConnection method explicitly. Since we are
        // forwarding a raw stream, we can not re-use the underlying socket
        // afterwards so we request that the websocket is terminated once the stream
        // is closed.
        this.createConnection({closeWebsocket: true}, cb);
    }
}

/**
 * The tunnel server.
 *
 * The server exposes a top level http API to create new tunnels, a WebSocket API to
 * register connections with existing tunnels, and the tunnel api that forwards requests
 * to a registered tunnel.
 */
class TunnelServer {
    constructor(config) {
        const defaultConfig = {
            host: null,
            port: 8085,
            scheme: 'https',
            subDomains: false,
            graceTimeout: 2,
            maxSlots: 10
        }
        this._config = Object.assign({}, defaultConfig, config);
        if(!this._config.host) throw new Error('No host specified');
        if(!this._config.port) throw new Error('No port specified');
        if(!this._config.scheme) throw new Error('No scheme specified');

        this._debug = require('debug')('tl:server');
        this._serverName = this._config.host;
        this._tunnels = [];
        this._tunnelNameSeparator = this._config.subDomains ? '.' : '-';
        this._maxSlots = this._config.maxSlots;
        this._tunnelCloseTimeouts = {};
        this._tunnelGraceTimeout = (this._config.graceTimeout || 2) * 1000;
    }

    /**
     * Creates and starts the server
     */
    start() {
        let server = this._createHttpServer();
        this._createWebSocketServer(server);
        server.listen(this._config.port, () => {
            this._debug(`Server started on ${this._config.port}`);
        });
    }

    /**
     * Starts a timeout for the given tunnel. If no connections are added to the tunnel in
     * time, the tunnel will be removed.
     *
     * @param {Tunnel} tunnel The tunnel
     * @private
     */
    _startConnectionGraceTimeout(tunnel) {
        this._debug('Staring tunnel close timeout for ' + tunnel.name);
        // clear any existing timeouts
        if (this._tunnelCloseTimeouts[tunnel.id]) {
            clearTimeout(this._tunnelCloseTimeouts[tunnel.id])
        }

        this._tunnelCloseTimeouts[tunnel.id] = setTimeout(() => {
            let status = tunnel.connectionStatus();
            if (status.available === 0 && status.connected === 0) {
                this._debug('No connections available for ' + tunnel.name + ' after grace period. Deleting tunnel');
                this._removeTunnel(tunnel);
            }
        }, this._tunnelGraceTimeout)
    }

    /**
     * Stops any deletion timeouts for the gien tunnel
     *
     * @param {Tunnel} tunnel The tunnel
     * @private
     */
    _stopConnectionGraceTimeout(tunnel) {
        if (this._tunnelCloseTimeouts[tunnel.id]) {
            this._debug('Stop tunnel close timeout for ' + tunnel.name);
            clearTimeout(this._tunnelCloseTimeouts[tunnel.id])
            delete this._tunnelCloseTimeouts[tunnel.id];
        }
    }

    /**
     * Removes the given tunnel
     *
     * @param {Tunnel} tunnel The tunnel
     * @private
     */
    _removeTunnel(tunnel) {
        let idx = this._tunnels.indexOf(tunnel);
        if (idx >= 0) {
            this._debug('Removing tunnel ' + tunnel.name);
            if (this._tunnelCloseTimeouts[tunnel.id]) {
                clearTimeout(this._tunnelCloseTimeouts[tunnel.id])
            }
            delete this._tunnelCloseTimeouts[tunnel.id];
            tunnel.removeAllListeners();
            tunnel.destroy();
            this._tunnels.splice(idx, 1);
        }
    }

    /**
     * Helper that finds a tunnel by the tunnel name
     *
     * @param name The tunnel name
     * @returns {Tunnel|undefined} The tunnel or undefined
     * @private
     */
    _findTunnelByName(name) {
        return this._tunnels.find(t => t.name === name);
    }

    /**
     * Finds a tunnel by its internal ID
     *
     * @param id
     * @returns {Tunnel|undefined} The tunnel or undefined
     * @private
     */
    _findTunnelById(id) {
        return this._tunnels.find(t => t.id === id);
    }

    /**
     * Finds a tunnel by its full host name
     *
     * @param hostName The host name
     * @returns {Tunnel|undefined}
     * @private
     */
    _findTunnelByHostName(hostName) {
        let name = hostName.replace(this._serverName, '');
        name = name.substr(0, name.length - 1);
        return this._findTunnelByName(name);
    }

    /**
     * Creates the http server and sets up routing.
     *
     * @returns {http.Server}
     * @private
     */
    _createHttpServer() {
        return http.createServer((req, res) => {
            const parsed = url.parse(req.url, true);
            const hostName = req.headers.host.split(":")[0];
            this._debug(`HTTP request received ${hostName}${req.url}`);

            const preferredTunnelName = parsed.query['new'];
            const localName = parsed.query['hostname'];
            const newTunnelRequested = preferredTunnelName === '' || preferredTunnelName;
            if (hostName === this._serverName && parsed.pathname === '/' && newTunnelRequested) {
                // If this request was for the tunnel server and the ?new parameter was specified
                // we create a new tunnel
                this._createNewTunnel(preferredTunnelName, res, localName);
            } else if (hostName !== this._serverName) {
                // If the requests host name is not the tunnel server, we assume that
                // the request is for one of the tunnels
                this._forwardHttpRequestToTunnel(hostName, res, req);
            } else {
                // everything else is just 404
                res.writeHead(404);
                res.end();
            }
        });
    }

    /**
     * Finds a tunnel for the given host name and forwards the request
     * to that tunnel
     *
     * @param hostName The full host name
     * @param res The request
     * @param req The response
     * @private
     */
    _forwardHttpRequestToTunnel(hostName, res, req) {
        let t = this._findTunnelByHostName(hostName);
        if (!t) {
            this._debug(`Tunnel for ${hostName} not found!`);
            res.writeHead(404);
            res.end()
            return;
        }
        t.handleHttpRequest(req, res);
    }

    /**
     * Takes an optional tunnel name and the response and creates a new tunnel.
     * If a tunnel with the preferred name already exists, a new random name is
     * generated.
     *
     * @param preferredTunnelName The preferred name
     * @param res The response
     * @param hostname The host name that will be injected into forwarded requests
     * @private
     */
    _createNewTunnel(preferredTunnelName, res, hostname) {
        const tunnelId = uuidv4();
        let tunnelName = createTunnelName();
        if (preferredTunnelName && !this._findTunnelByName(preferredTunnelName)) {
            tunnelName = preferredTunnelName;
        }
        const tunnelUrl = `${this._config.scheme}://${tunnelName}${this._tunnelNameSeparator}${this._serverName}`;
        this._debug('Create new tunnel connection to ' + tunnelUrl)
        const tunnel = new Tunnel(tunnelId, tunnelName, tunnelUrl, this._maxSlots, hostname);

        tunnel.on('connection-removed', () => {
            let status = tunnel.connectionStatus();
            if (status.available === 0 && status.connected === 0) {
                this._startConnectionGraceTimeout(tunnel);
            }
        });
        tunnel.on('connection-added', () => {
            this._stopConnectionGraceTimeout(tunnel);
        });
        this._tunnels.push(tunnel);

        // start the timeout to make sure that we get a connection for this new tunnel
        this._startConnectionGraceTimeout(tunnel);

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({tunnelUrl, tunnelName, tunnelId, maxSlots: this._maxSlots}));
    }

    /**
     * Creates the web socket server. The web socket server accepts tunnel connections
     * and also forwards web socket requests to tunnels.
     *
     * @param {http.Server} server The HTTP server
     * @returns {WebSocketServer}
     * @private
     */
    _createWebSocketServer(server) {
        const wsServer = new WebSocketServer({
            httpServer: server,
            noServer: true // TODO: This can be removed?
        });
        // noinspection JSUnresolvedFunction
        wsServer.on('request', this._handleWebSocketRequest.bind(this));
        return wsServer;
    }

    /**
     * Handles a web socket request. The request is either targets at the tunnel server
     * and carries a new connection for a tunnel or is targeted at a tunnel in which case it is
     * forwarded.
     *
     * @param request The request
     * @private
     */
    _handleWebSocketRequest(request) {
        const parsed = url.parse(request.httpRequest.url, true);
        const hostName = request.httpRequest.headers.host.split(":")[0];
        this._debug(`WS request received ${hostName}${request.httpRequest.url}`);

        let onErrorBeforeConnect = (err) => {
            this._debug('WS request error before connection could be accepted: ' + err.message);
        }
        request.httpRequest.socket.once('error', onErrorBeforeConnect)

        // If the request is not for the tunnel server, forward it
        if (hostName !== this._serverName) {
            this._forwardWebSocketRequest(request, hostName);
            return;
        }

        if (parsed.pathname !== '/connect') {
            this._debug('Rejecting unknown request to ' + parsed.pathname)
            request.reject(404);
            return;
        }

        // Get the tunnel id and make sure it exists.
        const tunnelId = parsed.query['id'];
        if (!tunnelId) {
            this._debug('Rejecting connection. No tunnel ID.')
            request.reject(404);
            return;
        }

        // Make sure that we have a tunnel for the given ID
        const tunnel = this._findTunnelById(tunnelId);
        if (!tunnel) {
            this._debug(`Tunnel ${tunnelId} not found`)
            request.reject(404);
            return;
        }

        // accept the connection and add it to the tunnel.
        // The tunnel might not accept the connection, in which case we close it again.
        const connection = request.accept('tunnel-protocol', request.origin);
        if (!tunnel.addConnection(connection)) {
            this._debug(`Tunnel connection not accepted by tunnel ${tunnel.id}.`)
            connection.close();
        } else {
            request.httpRequest.socket.off('error', onErrorBeforeConnect);
        }
    }

    /**
     * Forward a websocket request for the given host name
     *
     * @param request The request
     * @param hostName The host name
     * @private
     */
    _forwardWebSocketRequest(request, hostName) {
        let tunnel = this._findTunnelByHostName(hostName);
        if (!tunnel) {
            this._debug(`Tunnel for ${hostName} not found!`);
            request.reject(404);
            return;
        }
        tunnel.handleWebSocketRequest(request);
    }
}

function startServer(config) {
    let tunnelServer = new TunnelServer(config);
    tunnelServer.start()
}

exports.startServer = startServer;