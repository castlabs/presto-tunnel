const WebSocketClient = require('websocket').client;
const debug = require('debug')('tl:client');
const stream = require('stream');
const net = require('net');

/**
 * This wraps a Websocket connection into a Duplex Stream and handles connections to
 * the tunnel end pont on the local side.
 *
 * Stream wrapper for http://github.com/Worlize/WebSocket-Node.git version 1.0.8
 */
class WsStream extends stream.Duplex {
    constructor(ws, tunnelName, port) {
        super();
        this.debug = require('debug')('tl:stream:' + tunnelName)
        this.ws = ws;
        this.port = port;
        this._open = true;
        this.tcpConnection = null;
        this.tryToConnect = true;
        this.connected = false;
        this.pendingMessages = [];

        this.ws.on('message', (message) => {
            if (!this._open) {
                this.debug('Can not push data. Stream not open!')
                return;
            }
            if (message.type === 'utf8' && message.utf8Data === 'END') {
                if (this.tcpConnection == null) {
                    this.debug('Received stop!');
                    this.tryToConnect = false;
                    return;
                } else {
                    // the server requested the termination
                    // and we need to ack that so that the websocket connection can be re-used
                    // on the server side.
                    this.debug('Connection to local port closed forcefully');
                    this.closeLocalConnection();
                    this.ws.sendUTF('tcp-terminated');
                    return;
                }
            }

            if (this.tcpConnection == null) {
                this.pendingMessages.push(message);
                this.tryToConnect = true;
                this.connectLocal();
            } else if (!this.connected) {
                // waiting for connection
                this.pendingMessages.push(message);
            } else {
                this.handleMessage(message);
            }
        });

        this.ws.on('close', () => {
            this.debug('WebSocket Stream closed');
            this._open = false;
            this.closeLocalConnection();
            return this.emit('close');
        });

        this.ws.on('error', (err) => {
            this.debug('Error on WS Stream', err)
            this._open = false;
            this.closeLocalConnection();
            this.emit('error', err)
        });
    }

    handleMessage(message) {
        if (message.type === 'binary') {
            // this.debug('Pushing ' + message.binaryData.length + ' bytes to TCP');
            this.push(message.binaryData);
        }
    }


    connectLocal() {
        if (!this._open || !this.tryToConnect) {
            return;
        }

        if (this.tcpConnection) {
            this.debug('Already connected to local port');
            return;
        }

        this.debug('Trying to connect to local port ' + this.port);

        this.tcpConnection = net.connect(this.port, '127.0.0.1');
        this.tcpConnection.setNoDelay(true);
        this.tcpConnection.setKeepAlive(true);

        this.tcpConnection.once('connect', () => {
            this.debug(`Connection to local port ${this.port} established. Piping data.`);
            this.connected = true;
            this.pipe(this.tcpConnection, {end: true}).pipe(this, {end: false});
            if(this.pendingMessages.length > 0) {
                for (const message of this.pendingMessages) {
                    this.handleMessage(message);
                }
                this.pendingMessages = [];
            }
        });

        this.tcpConnection.once('close', () => {
            this.debug('Connection to local port closed.');
            this.closeLocalConnection();
        });

        this.tcpConnection.once('error', (err) => {
            this.debug('TCP connection error', err.message);
            this.closeLocalConnection();

            if (err.code === 'ECONNREFUSED' && this.tryToConnect) {
                // connection to the local side could not be established. Keep on trying though!
                setTimeout(() => {
                    this.connectLocal()
                }, 1000)
            } else if(err.code === 'ECONNRESET') {
                this.end();
            }
        })
    }

    end() {
        this.debug('Ending WS Stream')
        super.end();
        this._open = false;
        this.closeLocalConnection();
        return this.ws.close();
    }

    closeLocalConnection() {
        if (this.tcpConnection != null) {
            this.tcpConnection.end();
            this.tcpConnection.removeAllListeners();
            this.tcpConnection = null;
        }
        this.pendingMessages = [];
        this.connected = false;
    }

    // node stream overrides
    // @push is called when there is data, _read does nothing
    _read() {
    }

    // if callback is not called, then stream write will be blocked
    _write(chunk, encoding, callback) {
        if (this._open) {
            // this.debug('Send ' + chunk.length + ' bytes upstream through WS');
            return this.ws.sendBytes(chunk, callback);
        } else {
            this.debug('Can not write data. Stream no open.')
            callback(new Error('stream not open'));
        }
    }
}

function maybeCreateConnection(tunnel) {
    if (tunnel.availableSlots > 0) {
        const client = new WebSocketClient();
        client.on('connectFailed', (error) => {
            if (error.code === 'ECONNREFUSED') {
                console.error('Connect Error. Connection Refused. Trying again ...');
                setTimeout(() => {
                    maybeCreateConnection(tunnel)
                }, 1000);
            } else {
                // TODO: Handle the case where we can not create a connection better and
                // make sure that the client terminates
                console.error('Connect Error: ' + error.toString());
            }
        });

        client.on('connect', function (connection) {
            debug('WebSocket Client Connected for ' + tunnel.tunnelName + ` ${tunnel.maxSlots - tunnel.availableSlots + 1} / ${tunnel.maxSlots}`);
            const stream = new WsStream(connection, tunnel.tunnelName, tunnel.localPort);
            stream.once('close', () => {
                tunnel.availableSlots += 1;
                maybeCreateConnection(tunnel);
            })
            stream.once('error', () => {
                tunnel.availableSlots += 1;
                maybeCreateConnection(tunnel);
            });
            // see if there is another connection available
            tunnel.availableSlots -= 1;
            maybeCreateConnection(tunnel)
        });
        let host = tunnel.tunnelHost;
        if(!host.endsWith('/')) {
            host += '/';
        }
        let connectUrl = `${host}connect?id=${tunnel.tunnelId}`;
        connectUrl = connectUrl.replace("https://", "wss://");
        connectUrl = connectUrl.replace("http://", "ws://");
        debug('Connection to tunnel ' + tunnel.tunnelName + ` slot ${tunnel.maxSlots - tunnel.availableSlots + 1} / ${tunnel.maxSlots} at ${connectUrl}`);
        client.connect(connectUrl, 'tunnel-protocol');
    }
}

async function fetch(target) {
    return new Promise((resolve, reject) => {
        const url = new URL(target)
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
        req.end()
    });
}

async function tunnel(tunnelHost, localPort, preferredName) {
    if (!tunnelHost) throw Error('no host');
    if (!localPort) throw Error('no local port');
    preferredName = preferredName || '';

    const url = new URL(tunnelHost)
    url.searchParams.append('new', preferredName)


    const tunnelData = await fetch(url);
    tunnelData.availableSlots = tunnelData.maxSlots;
    tunnelData.localPort = localPort;
    tunnelData.tunnelHost = tunnelHost;
    maybeCreateConnection(tunnelData);
    return tunnelData.tunnelUrl;
}

exports.tunnel = tunnel;