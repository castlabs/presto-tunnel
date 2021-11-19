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
        this.pendingMessages = [];

        this.ws.on('message', (message) => {
            if (!this._open) {
                this.debug('Can not push data. Stream not open!')
                return;
            }

            if (this.tcpConnection == null) {
                if (message.type === 'utf8' && message.utf8Data === 'END') {
                    this.debug('Received stop! Not trying to create a socket!');
                    this.tryToConnect = false;
                    return;
                }
                this.debug('No TCP connection to local port available. Trying to connect and hold message.')
                this.pendingMessages.push(message);
                this.tryToConnect = true;
                this.connectLocal();
                return;
            }
            this.handleMessage(message);
        });

        this.ws.on('close', () => {
            this.debug('WebSocket Stream closed');
            this._open = false;
            if (this.tcpConnection) {
                this.tcpConnection.end();
                this.tcpConnection.removeAllListeners();
                this.tcpConnection = null;
            }
            return this.emit('close');
        });

        this.ws.on('error', (err) => {
            this.debug('Error on WS Stream', err)
            if (this.tcpConnection) {
                this.tcpConnection.end();
                this.tcpConnection.removeAllListeners();
                this.tcpConnection = null;
            }
            this.emit('error', err)
        });
    }

    handleMessage(message) {
        if (message.type === 'binary') {
            this.debug('Received Binary Message of ' + message.binaryData.length + ' bytes');
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

        this.tcpConnection = net.connect(this.port);
        this.tcpConnection.setNoDelay(true);
        this.tcpConnection.setKeepAlive(true);

        this.tcpConnection.once('connect', () => {
            this.debug(`Connection to local port ${this.port} established. Resuming socket and piping data.`);
            // this.ws.socket.resume();
            this.pipe(this.tcpConnection, {end: true}).pipe(this, {end: false});
            for (const message of this.pendingMessages) {
                this.handleMessage(message);
            }
            this.pendingMessages = [];
        });

        this.tcpConnection.once('close', () => {
            this.debug('TCP connection to local port closed.');

            this.tcpConnection.end();
            this.tcpConnection.removeAllListeners();
            this.tcpConnection = null;
        });

        this.tcpConnection.once('error', (err) => {
            this.debug('TCP connection error', err.message);
            this.tcpConnection.end();
            this.tcpConnection.removeAllListeners();
            this.tcpConnection = null;

            if (err.code === 'ECONNREFUSED' && this.tryToConnect) {
                // connection to the local side could not be established. Keep on trying though!
                setTimeout(() => {
                    this.connectLocal()
                }, 1000)
            }
        })
    }

    end() {
        this.debug('Ending WS Stream')
        super.end();
        if (this.tcpConnection != null) {
            this.tcpConnection.end();
        }
        return this.ws.close();
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
            // see if there is another connection available
            tunnel.availableSlots -= 1;
            maybeCreateConnection(tunnel)
        });
        let connectUrl = `${tunnel.tunnelHost}/connect?id=${tunnel.tunnelId}`;
        debug('Connection to tunnel ' + tunnel.tunnelName + ` slot ${tunnel.maxSlots - tunnel.availableSlots + 1} / ${tunnel.maxSlots}`);
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