const WebSocketClient = require('websocket').client;
const EventEmitter = require('events');
const {WebsocketStream, LocalStream, createCommand, COMMANDS} = require("./streams");


/**
 * Helper that does an async GET and expects to receive a JSON
 * response that is parsed and returned.
 *
 * @param {URL} url The target URL
 * @param {string} hostName Optional host name overwrite
 * @returns {Promise<Object>} Promised that resolves to the json response
 */
async function fetch(url, hostName) {
    return new Promise((resolve, reject) => {
        const scheme = url.protocol.startsWith("https") ? 'https' : 'http';
        const port = url.protocol.startsWith("https") ? 443 : 80;
        const https = require(scheme)
        const options = {
            hostname: url.hostname,
            port: url.port || port,
            path: url.pathname + url.search,
            method: 'GET'
        }

        const req = https.request(options, res => {
            if (res.statusCode < 200 || res.statusCode >= 400) {
                reject(res.statusCode)
            }
            let body = "";
            res.on('data', d => {
                body += d;
            })
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(err);
                }
            })
        })
        req.on('error', error => {
            reject(error);
        })
        if (hostName) {
            req.setHeader('host', `${hostName}:${url.port || port}`)
        }
        req.end()
    });
}

/**
 * The available client states
 * @type {{CLOSED: string, CONNECTING: string, PREPARING: string, CONNECTED: string}}
 */
const ClientState = {
    // The client is disconnected from the server
    CLOSED: 'CLOSED',
    // The client is trying to establish a connection to the
    // server
    CONNECTING: 'CONNECTING',
    // The server connection is established and the client is
    // preparing the streams and the pipeline
    PREPARING: 'PREPARING',
    // The client is connected to the server and the the streams
    // are established
    CONNECTED: 'CONNECTED'
}

/**
 * A client connection to the server. The client connection, once connected,
 * manages a web socket connection to the server, the remote stream to and from
 * the server and a local stream to and from the local tcp connection as well
 * as the pipe between them.
 *
 * The following events are emitted
 *
 *  connection-failed   Contains a 'response' argument as this is triggered when the server
 *                      could be reached but rejected the connection.
 *  connect-failed      This is triggered with an 'error' when the connection to the server
 *                      could not be established at all
 *  connecting          The connection is being established
 *  preparing           The web socket connection is established and the client connection is
 *                      about to create the stream and the pipe. Note that this is also triggered
 *                      when the local stream needs to be re-established. The connection is in
 *                      connecting mode when this is triggered.
 *  connected           The remote and local streams are created and the connection is established
 *  close               The connection to the server was closed and this client connection can
 *                      no longer be used before an explicit re-connect.
 *  request             Is issued when a request command comes on on the remote connection and
 *                      contains the request id and a simplified optional request object with method
 *                      and path.
 */
class ClientConnection extends EventEmitter {
    constructor(id, localPort, localHost="127.0.0.1") {
        super();
        /**
         * The current state
         * @type {string}
         */
        this.state = ClientState.CLOSED;

        this._debug = require('debug')('tl:client:connection[' + id + ']');
        this._client = null;
        this._id = id;
        /**
         * The upstream stream to the server
         * @type {WebsocketStream|null}
         * @private
         */
        this._remoteStream = null;
        /**
         * The downstream stream to the local tcp host/port
         *
         * @type {LocalStream|null}
         * @private
         */
        this._localStream = null;
        /**
         * The local port
         *
         * @private
         */
        this._localPort = localPort;
        /**
         * The local host or IP to connect to
         * @type {string}
         * @private
         */
        this._localHost = localHost;
    }

    connect(host, hostName, connectId) {
        if (this.state !== ClientState.CLOSED) {
            throw new Error('The client is not in CLOSED state but: ' + this.state);
        }
        // Start connecting to the server
        this.state = ClientState.CONNECTING;
        this._debug('Client state', this.state);
        this.emit('connecting');
        this._client = new WebSocketClient();

        // The connection was established, i.e we could reach the server,
        // but the web socket connection was rejected.
        // Clean the client and forward the error.
        // This ClientConnection can be re-used afterwards
        this._client.on('httpResponse', (response) => {
            this._debug('Unable to establish connection. Server responded with', response.statusCode);
            this._closeClient();
            this.emit('connection-failed', response);
        });
        // The connect failed with an error. Since we are also listening to
        // httpResponse, this happens _only_ when the connection to the
        // server could not be established at all.
        this._client.on('connectFailed', (error) => {
            this._debug('Unable to connect to server: ' + error.message);
            this._closeClient();
            this.emit('connect-failed', error);
        })

        // handle the connect case
        this._client.on('connect', (connection) => {
            this._debug(`WebSocket connection established`);

            // Stop listening to anything on the client now that we have
            // a connection
            this._client.removeAllListeners();

            // handle the case where the connection is closed and
            // do a full cleanup
            connection.once('close', () => {
                this._debug('Client connection closed');
                // clean the connection
                connection.removeAllListeners();
                this._closeClient();
                this.emit('close');
            });

            // we are no longer connecting
            // but we do not mark this as connected yet. That happens
            // once the local stream is created
            this.state = ClientState.PREPARING;
            this._debug('Client state', this.state);
            this.emit('preparing');
            // create the remote stream
            this._createRemoteStream(connection);
            // create the local stream
            this._createLocalStream(connection);
        });

        if (!host.endsWith('/')) {
            host += '/';
        }
        let connectUrl = `${host}connect?id=${connectId}`;
        connectUrl = connectUrl.replace("https://", "wss://");
        connectUrl = connectUrl.replace("http://", "ws://");

        this._debug(`Connecting slot ${this._id} ${connectUrl}`);
        let headers = {}
        if (hostName) {
            headers['Host'] = hostName;
        }
        this._client.connect(connectUrl, 'tunnel-protocol', undefined, headers);
    }

    _createRemoteStream(connection) {
        if (this._remoteStream) {
            throw new Error('Remote stream exists already.');
        }
        this._remoteStream = new WebsocketStream(connection, this._id);
        this._remoteStream.on('end', () => {
            this._debug('Remote stream ended.');
            // similar to the error case we need to consider this connection lost
            // and close it
            connection.close();
        });
        this._remoteStream.on('request', (id, req) => {
            this.emit('request', id, req);
        });
        this._remoteStream.on('response', (id, res) => {
            this.emit('response', id, res);
        });
        this._remoteStream.once('error', (err) => {
            this._debug(`Error on remote stream: ${err}`)
            // If the remote stream ends with an error we have to consider
            // this connection lost and close it
            connection.close()
        });

        this._remoteStream.on('terminate', () => {
            if (this._localStream) {
                this._debug('Local stream termination requested.');
                this._localStream.destroy()
            }
        });

    }

    _createLocalStream(connection) {
        if (this._localStream) {
            throw new Error('local stream exists already!');
        }
        if (!this._remoteStream) {
            throw new Error('remote stream does not exist!');
        }
        this._localStream = new LocalStream(this._id, this._localPort, this._localHost);
        this._localStream.on('close', () => {
            // This is triggered when we destroy the local stream
            // upon request from the server. That way 'end' is avoided and we
            // do not send a LOCAL_END to the server since the request to
            // kill the stream actually came from the server.
            this._debug('Local stream close');
            this._recreateLocalStream(connection)
        });
        this._localStream.on('end', () => {
            this._debug('Local stream end');
            // send the information that the local connection was terminated
            // to the server. This is mostly redundant since the server will
            // realize the end of the connection for a "normal" connection, however,
            // if the local connection ends pre-maturely, the server will not know and
            // will keep the proxy connection alive, i.e. the users client will hang and wait.
            // To avoid that we send a termination request explicitly here.
            this._debug(`Sending command ${COMMANDS.LOCAL_END} for ${this._remoteStream.requestId}`);
            connection.sendUTF(createCommand(COMMANDS.LOCAL_END, this._remoteStream.requestId));
            // recreate the local stream
            this._recreateLocalStream(connection)
        });
        this._localStream.on('error', (err) => {
            this._debug(`Local stream error ${err.message}.`)
            // Send the error upstream
            this._debug(`Sending command ${COMMANDS.LOCAL_ERROR} for ${this._remoteStream.requestId}`)
            connection.sendUTF(createCommand(COMMANDS.LOCAL_ERROR, this._remoteStream.requestId, {error: err.message}));
            // recreate the local stream
            this._recreateLocalStream(connection)
        });

        // pipe remote <-> local but make sure that we are not ending the remote stream
        // since that is the web socket stream and we want to keep that open
        this._remoteStream.pipe(this._localStream).pipe(this._remoteStream, {end: false});
        // mark this as connected
        this.state = ClientState.CONNECTED;
        this._debug('Client state', this.state);
        this.emit('connected');
    }

    _recreateLocalStream(connection) {
        if (!this._remoteStream) {
            throw new Error('No remote-stream available. Can not re-create local stream.')
        }
        if (!this._localStream) {
            throw new Error('No local-stream available. Can not re-create local stream.')
        }
        this._debug('Re-creating local stream.');
        // we are no longer connected!
        this.state = ClientState.PREPARING;
        this._debug('Client state', this.state);
        this.emit('preparing')
        // unpipe the connection
        this._remoteStream.unpipe();
        this._localStream.unpipe();

        // make sure the local stream is closed
        this._closeStream(this._localStream);
        this._localStream = null;

        // create the local stream again
        this._createLocalStream(connection);
    }

    _closeClient() {
        this._closeStreams();
        if (this._client) {
            this._client.removeAllListeners();
        }
        this.state = ClientState.CLOSED;
        this._debug('Client state', this.state);
        this._client = null;
    }

    _closeStreams() {
        if (this._localStream) {
            this._closeStream(this._localStream);
            this._localStream = null;
        }

        if (this._remoteStream) {
            this._closeStream(this._remoteStream);
            this._remoteStream = null;
        }
    }

    _closeStream(stream) {
        stream.removeAllListeners();
        stream.unpipe();
        stream.end();
    }
}

/**
 * The client tunnel.
 *
 * call `connect()` to establish the connection to the tunnel server.
 *
 * The following events will be emitted:
 *
 *  connected  Provides the tunnel url and is triggered once the tunnel is established
 *  error      In case an error occurs while connecting to the tunnel
 *  request    When a HTTP request is coming in. Contains the request id and an optional
 *             simplified request object with method and path.
 *  response   When a HTTP response is coming in. Contains the request id and an optional
 *             object with method, path, and statusCode for the response.
 */
class ClientTunnel extends EventEmitter {
    constructor(config) {
        super();
        let defaultConfig = {
            // The URL to the tunnel server
            tunnelHost: null,
            // The local port to connect to
            localPort: null,
            // The local host name or IP to connect to
            localHost: '127.0.0.1',
            // The host name that will be injected into request
            // when forwarding to the client
            localName: null,
            // The preferred name for the tunnel.
            preferredName: '',
            // The hostname that will be used when creating requests to the tunnel server.
            // This is primarily used for development to avoid the need to make
            // host names available. For example, you can set the tunnelHost
            // to http://localhost:8085 and set this to 'tunnel.server'. When requests
            // to the tunnel server are created the host name is set to 'tunnel.server'
            // and the tunnerl server will be able to handle the connection properly
            hostName: null
        }
        /**
         * The configuration
         * @private
         */
        this._config = Object.assign({}, defaultConfig, config);
        /**
         * Logger
         *
         * @type {debug}
         * @private
         */
        this._debug = require('debug')('tl:client');
        /**
         * The internal ID of this tunnel. This will be available
         * after the connection is established
         *
         * @type {null|string}
         * @private
         */
        this._id = null;
        /**
         *
         * @type {ClientConnection[]|null}
         * @private
         */
        this._slots = null;
        /**
         * True once the tunnel is connected
         *
         * @type {boolean}
         * @private
         */
        this._connected = false;
        /**
         * The tunnel URL. This is set once the tunnel
         * is connected
         *
         * @type {null|string}
         */
        this.tunnelUrl = null;
    }

    /**
     * Start connecting the tunnel slots
     */
    connect() {
        if (!this._config.tunnelHost) throw Error('No tunnelHost specified');
        if (!this._config.localPort) throw Error('No local port specified');
        if (this._connected) throw Error('Tunnel already connected');

        this._connected = true;
        let preferredName = this._config.preferredName;
        // Register a new tunnel
        const url = new URL(this._config.tunnelHost);
        url.searchParams.append('new', preferredName)
        url.searchParams.append('hostname', this._config.localName)
        fetch(url, this._config.hostName).then(tunnelData => {
            this._id = tunnelData.tunnelId;
            this._slots = new Array(Number(tunnelData.maxSlots));
            this.tunnelUrl = tunnelData.tunnelUrl;

            // Create the client connections
            for (let i = 0; i < this._slots.length; i++) {
                this._slots[i] = new ClientConnection(i, this._config.localPort, this._config.localHost);
            }

            // start connecting the clients.
            this._createConnection();

            this.emit('connected', this.tunnelUrl)
        }).catch(err => {
            this._debug('Error while connecting tunnel: ' + err)
            this._connected = false;
            this.emit('error', err)
        });
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
        let total = this._slots.length;
        let available = 0;
        let connected = 0;
        let waiting = 0;
        let free = 0;
        for (let i = 0; i < this._slots.length; i++) {
            let connection = this._slots[i];
            switch (connection.state) {
                case ClientState.CLOSED:
                    free++;
                    break;
                case ClientState.PREPARING:
                    connected++;
                    break;
                case ClientState.CONNECTING:
                    waiting++;
                    break;
                case ClientState.CONNECTED:
                    available++;
                    break;
            }
        }
        return {total, available, connected, free, waiting};
    }

    /**
     * Find a free slot or return -1
     *
     * @returns {number} The index of a free slot or -1
     * @private
     */
    _findEmptySlot() {
        for (let i = 0; i < this._slots.length; i++) {
            let c = this._slots[i];
            if (c.state === ClientState.CLOSED) return i;
        }
        return -1;
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

    _createConnection() {
        let slotIdx = this._findEmptySlot();
        if (slotIdx < 0) {
            return;
        }
        let client = this._slots[slotIdx];
        client.on('connection-failed', (r) => {
            // The client connection was established but the tunnel could
            // not be created. This is considered fatal
            console.error('Unable to establish tunnels. Server responded with', r.statusCode, r.status ? r.status : '');
            process.exit(1);
        });

        client.on('request', (id, req) => {
            this.emit('request', id, req);
        });

        client.on('response', (id, res) => {
            this.emit('response', id, res);
        });

        client.on('connect-failed', (error) => {
            // the connection to the server could not be established.
            // If the connection was refused we are going to retry, otherwise this is considered
            // fatal
            client.removeAllListeners();
            if (error.code === 'ECONNREFUSED') {
                console.error('Connection Refused. Trying again ...');
                setTimeout(() => {
                    this._createConnection();
                }, 1000);
            } else {
                console.error('Unable to connect to server ' + error.message);
                process.exit(1);
            }
        });

        client.on('close', () => {
            this._debug(`Client connection ${slotIdx} closed. Re-Creating connection`);
            client.removeAllListeners();
            this._createConnection();
        });

        client.on('connected', () => {
            this._createConnection();
        });

        client.connect(this._config.tunnelHost, this._config.hostName, this._id);
    }

}

function createTunnel(config) {
    return new ClientTunnel(config);
}

exports.createTunnel = createTunnel;