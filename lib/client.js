const WebSocketClient = require('websocket').client;
const debug = require('debug')('tl:client');
const stream = require('stream');
const net = require('net');
const EventEmitter = require('events');
const {WebsocketStream, LocalStream} = require("./streams");


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

class ClientTunnel extends EventEmitter {
    constructor(id, slots, localPort, tunnelServerUrl, tunnelUrl, hostName) {
        super();
        this._id = id;
        this._debug = require('debug')('tl:client');
        this._slots = new Array(slots).fill(null);
        this._localStreams = new Array(slots).fill(null);
        this._localPort = localPort;
        this._tunnelServerUrl = tunnelServerUrl;
        this._hostName = hostName;
        this.tunnelUrl = tunnelUrl;
    }

    /**
     * Start connecting the tunnel slots
     */
    connect() {
        this._createConnection();
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
            if (!connection) {
                free++;
            } else {
                if (this._localStreams[i]) {
                    connected++;
                } else {
                    available++;
                }
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
            if (this._slots[i] == null) return i;
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

    _handleWsConnectionFailed(error, client) {
        client.removeAllListeners();
        if (error.code === 'ECONNREFUSED') {
            console.error('Connect Error. Connection Refused. Trying again ...');
            setTimeout(() => {
                this._createConnection();
            }, 1000);
        } else {
            // make sure that the client terminates
            console.error('Connect Error: ' + error.toString());
        }
    }

    _createConnection() {
        let slotIdx = this._findEmptySlot();
        if (slotIdx < 0) {
            return;
        }
        // Fill the slot with a non null value to mark
        // this slot as currently being connected
        this._slots[slotIdx] = true;
        const client = new WebSocketClient();
        client.on('connectFailed', (error) => {
            // release the slot so it can be re-used
            client.removeAllListeners();
            this._slots[slotIdx] = null;
            this._handleWsConnectionFailed(error, client);
        });
        client.on('httpResponse', (r) => {
            // If we get a response here, something went terribly wrong
            client.removeAllListeners();
            this._slots[slotIdx] = null;
            console.error('Unable to establish tunnels. Server responded with', r.statusCode, r.status ? r.status : '');
            process.exit(1);
        });

        client.on('connect', (connection) => {
            this._debug(`WebSocket for slot  ${slotIdx} connected. ${this._connectionStatusString()}`);
            client.removeAllListeners();
            let remoteStream = new WebsocketStream(connection, slotIdx);
            this._slots[slotIdx] = remoteStream;

            let localStream = new LocalStream(slotIdx, this._localPort);
            this._localStreams[slotIdx] = localStream;
            localStream.on('close', () => {
                this._debug('Local stream close');
            });
            localStream.on('end', () => {
                this._debug('Local stream end. Informing server side.');
                connection.sendUTF('tcp-terminated');
                recreateLocalStream();
            });

            // In case we get an error from the local stream
            // we need to tell upstream about it
            const recreateLocalStream = (err) => {
                if (err) {
                    this._debug(`Local stream error ${err.message}. Re-Creating local stream and reporting error.`);
                } else {
                    this._debug(`Re-Creating local stream ${slotIdx}.`);
                }

                // unpipe the local and remote streams
                remoteStream.unpipe();
                localStream.unpipe();

                // remove listeners and recreate the local stream
                localStream.removeAllListeners();

                // recreate the local stream
                localStream = new LocalStream(slotIdx, this._localPort);
                this._localStreams[slotIdx] = localStream;
                localStream.on('close', () => {
                    this._debug('Local stream close');
                });
                localStream.on('end', () => {
                    this._debug('Local stream end. Informing server side.');
                    connection.sendUTF('tcp-terminated');
                    recreateLocalStream();
                });
                // setup the recursive error listener
                localStream.on('error', recreateLocalStream);
                // recreate the pipe
                remoteStream.pipe(localStream).pipe(remoteStream, {end: false});

                if (err) {
                    connection.sendUTF(JSON.stringify({error: err.message}));
                }

            }
            // setup the recursive error listener
            localStream.on('error', recreateLocalStream);

            // pipe remote <-> local but make sure that we are not ending the remote stream
            // since that is the web socket stream and we want to keep that open
            remoteStream.pipe(localStream).pipe(remoteStream, {end: false});

            // on close or error we need to release the connection and the stream
            connection.once('close', () => {
                client.removeAllListeners();
                remoteStream.end();
                remoteStream.unpipe();
                remoteStream.removeAllListeners();
                connection.removeAllListeners();
                this._slots[slotIdx] = null;

                localStream.removeAllListeners();
                localStream.unpipe();
                localStream.end();
                this._localStreams[slotIdx] = null;
                this._createConnection();
            })

            remoteStream.on('end', () => {
                // TODO: Remote is dead. Add some more cleanup
                this._debug('Remote stream ended.');
            });

            remoteStream.on('terminate', () => {
                this._debug('Local stream termination requested.');
                localStream.end();
                recreateLocalStream();
            });

            remoteStream.once('error', (err) => {
                this._debug(`Error on stream ${slotIdx}: ${err}`)
                client.removeAllListeners();
                remoteStream.end();
                remoteStream.unpipe();
                remoteStream.removeAllListeners();
                connection.removeAllListeners();
                this._slots[slotIdx] = null;

                let localStream = this._localStreams[slotIdx];
                localStream.removeAllListeners();
                localStream.unpipe();
                localStream.end();
                this._localStreams[slotIdx] = null;
                this._createConnection();
            });

            // we are connected now. Try to fill another slot
            this._createConnection();
        });

        let host = this._tunnelServerUrl;
        if (!host.endsWith('/')) {
            host += '/';
        }
        let connectUrl = `${host}connect?id=${this._id}`;
        connectUrl = connectUrl.replace("https://", "wss://");
        connectUrl = connectUrl.replace("http://", "ws://");

        this._debug(`Connecting slot ${slotIdx} ${connectUrl}`);
        let headers = {}
        if(this._hostName) {
            headers['Host'] = `${this._hostName}`
        }
        client.connect(connectUrl, 'tunnel-protocol', undefined, headers);
    }

}

async function createTunnel(tunnelHost, localPort, preferredName, hostName) {
    if (!tunnelHost) throw Error('no host');
    if (!localPort) throw Error('no local port');
    preferredName = preferredName || '';

    // Register a new tunnel
    const url = new URL(tunnelHost)
    url.searchParams.append('new', preferredName)
    const tunnelData = await fetch(url, hostName);

    // Create and connect the new tunnel
    let tunnel = new ClientTunnel(
        tunnelData.tunnelId,
        tunnelData.maxSlots,
        localPort,
        tunnelHost,
        tunnelData.tunnelUrl,
        hostName
    );
    tunnel.connect();
    return tunnel;
}

exports.createTunnel = createTunnel;