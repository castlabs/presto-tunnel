const stream = require('stream');
const WebSocketConnection = require('websocket').connection;
const EventEmitter = require('events');
const net = require("net");

const LOG_DATA = false;

const COMMANDS = {
    // Command issues when a local tcp connection encounters
    // and error and needs to send that to the server.
    //
    // Payload:
    //   error - The error message
    LOCAL_ERROR: 'local-error',
    // Command issued when the local stream ended. This might be
    // redundant for the server side but there are cases where the
    // server can not otherwise detect that the local connection
    // on the client terminated
    LOCAL_END: 'local-end',
    // Command issues when the server requests that the client terminates
    // a connection.
    REMOTE_END: 'remote-end',
    // Command issued when the server received a request that
    // will be forwarded. The clients will learn about the request
    // and its request id out of band since the client does not
    // actively read the proxies tcp connection.
    //
    // The request can can have optional information
    // about the actual request:
    //
    //   method    the http method
    //   path      the path
    REQUEST: 'request',
    // Command issued when the server identified an HTTP response
    // to inform the client about the response status.
    //
    // Note that this command is allowed to arrive out of band on the
    // client and the request id might not match the current request id
    // in case the client connection is already processing the new request.
    //
    // Additional properties:
    //   method      the HTTP method
    //   path        the path
    //   statusCode  the http status code of the response
    RESPONSE: 'response'
}

/**
 *
 * @param {string} command The command
 * @param {string} requestId The request id
 * @param {object|undefined} payload Optional additional payload
 * @returns {string} The string representation of the command
 */
function createCommand(command, requestId, payload = undefined) {
    if (Object.values(COMMANDS).indexOf(command) < 0) {
        throw new Error(`Unknown command "${command}"`);
    }
    if (!requestId) {
        throw new Error('No request id specified');
    }

    return JSON.stringify(Object.assign({}, {
        cmd: command,
        rid: requestId
    }, payload))
}

/**
 * WebSocket stream that takes an existing websocket connection and
 * uses that to read and write data as part of a duplex stream. When the
 * stream ends, the web socket connection is not terminated or closed so
 * that it can be used for another stream.
 */
class WebsocketStream extends stream.Duplex {
    constructor(ws, id) {
        super();
        /**
         * The websocket stream
         *
         * @type {WebSocketConnection}
         */
        this.ws = ws;
        /**
         * Logger
         * @private
         */
        this._debug = require('debug')('tl:websocket:' + id);
        /**
         * Logger for data transmission
         * @private
         */
        this._debug_data = require('debug')('tl:websocket:' + id + ':data');
        /**
         * We need to track the open state of this duplex stream manually
         * it is considered closed only when the websocket connection is
         * closed, not when this stream is closed. That way the stream
         * can be re-used for multiple connections
         *
         * @type {boolean}
         * @private
         */
        this._open = true;
        /**
         * The message handler reference
         * @private
         */
        this._messageHandler = this._handleWsMessage.bind(this);

        this._id = id;

        this.requestId = '';

        // Initialize the stream by listening to message on the web socket
        // noinspection JSUnresolvedFunction
        this._debug('Connecting message handler');
        this.ws.on('message', this._messageHandler);
    }


    /**
     * Disconnects the stream from the web socket and stops listening to messages.
     *
     * @private
     */
    _disconnect() {
        // noinspection JSUnresolvedFunction
        this._debug('Disconnecting message listener');
        this.ws.off('message', this._messageHandler);
    }

    /**
     * Handle websocket messages
     *
     * @param message The message
     * @private
     */
    _handleWsMessage(message) {
        if (message.type === 'utf8') {
            // get the comment message
            let msg;
            try {
                msg = JSON.parse(message.utf8Data);
            } catch {
                this._debug('Do not know how to handle message: ' + message.utf8Data);
                return;
            }
            this._debug(`Received command ${msg.cmd} for ${msg.rid}`);

            // we need to handle the REQUEST and RESPONSE command separately since we
            // do not need to do a request ID check!
            if(COMMANDS.REQUEST === msg.cmd) {
                this.requestId = msg.rid;
                this.emit('request', msg.rid, {
                    method: msg.method,
                    path: msg.path
                });
                return;
            }
            if(COMMANDS.RESPONSE === msg.cmd) {
                this.emit('response', msg.rid, {
                    method: msg.method,
                    path: msg.path,
                    statusCode: msg.statusCode
                });
                return;
            }

            // check the request id
            if (msg.rid !== this.requestId) {
                this._debug(`Ignoring command ${msg.cmd}. Request IDs do not match ${this.requestId} != ${msg.rid}`);
                return;
            }

            // Handle all the other commands
            switch (msg.cmd) {
                case COMMANDS.LOCAL_END:
                    this.end();
                    break;
                case COMMANDS.LOCAL_ERROR:
                    this._debug('Ending stream after receiving remote error: ' + msg.error);
                    this.end();
                    break;
                case COMMANDS.REMOTE_END:
                    this.emit('terminate');
                    break;
            }
        } else if (message.type === 'binary') {
            if (LOG_DATA) {
                this._debug_data('Read ' + message.binaryData.length + ' bytes');
            }
            if (this._open) {
                this.push(message.binaryData);
            }
        }
    }

    /**
     * Sends an explicit end request to the client if the connection is still open to stop
     * the stream. The client will terminate the client connection and acknowledge the
     * termination with a tcp-terminated message that will cause the stream on the server
     * side to also terminate.
     *
     * Note that this does not immediately terminated and end the stream.
     */
    stop() {
        if (this._open) {
            this._debug(`Sending command ${COMMANDS.REMOTE_END} for ${this.requestId}`)
            this.ws.sendUTF(createCommand(COMMANDS.REMOTE_END, this.requestId), () => {
                // TODO Check if we really need this nested
                this.end();
            });
        }
    }

    sendResponse(requestId, request, response) {
        response = response || {};
        request = request || {};
        this._debug(`Sending command ${COMMANDS.RESPONSE} for ${requestId}`);
        this.ws.sendUTF(createCommand(COMMANDS.RESPONSE, requestId, {
            method: request.method,
            path: request.url,
            statusCode: response.statusCode
        }));
    }

    setRequestId(id, request) {
        this._debug('Setting request id: ' + id);
        this.requestId = id;
        this._debug(`Sending command ${COMMANDS.REQUEST} for ${id}`);
        request = request || {};
        this.ws.sendUTF(createCommand(COMMANDS.REQUEST, id, request));
    }

    // node stream overrides
    end() {
        super.end();
        // emit an end event but make sure that we are NOT closing the WS socket since
        // we want to reuse that one.
        if (this._open) {
            this._debug('Closing stream');
            this._open = false;
            this.requestId = '';
            this._disconnect();
            this.emit('end');
        }
    }

    // @push is called when there is data, _read does nothing
    // noinspection JSUnusedGlobalSymbols
    _read() {
    }

    // if callback is not called, then stream write will be blocked
    // noinspection JSUnusedGlobalSymbols
    _write(chunk, encoding, callback) {
        if (this._open) {
            if (LOG_DATA) {
                this._debug_data('Write ' + chunk.length + ' bytes');
            }
            return this.ws.sendBytes(chunk, callback);
        } else {
            this._debug('Can not write data. Stream no open.')
            callback(new Error('Stream is not open!'));
        }
    }
}

/**
 * A duplex stream that lazily opens a connection to the specified
 * host and port when a write is requested.
 */
class LocalStream extends stream.Duplex {
    constructor(id, port, host = "127.0.0.1") {
        super();
        this._id = id;
        this._port = port;
        this._host = host;
        this._debug = require('debug')(`tl:local:${id}`);
        this._debug_data = require('debug')(`tl:local:${id}:data`);

        this._localConnection = null;
        this._localConnectionCallback = null;
        this._open = true;
    }

    /**
     * Destroy the local connection and make this stream available for a new connection
     *
     * @private
     */
    _closeLocalStream() {
        if (this._localConnection != null) {
            this._localConnection.removeAllListeners();
            this._localConnection.destroy();
            this._localConnection = null;
            this._localConnectionCallback = null;
        }
    }

    _createLocalStream(chunk, encoding, callback) {
        if (this._localConnection != null) {
            throw new Error(`Connection ${this._id} already exists`);
        }
        // Create the connection to the local port
        this._debug(`Connecting local to ${this._host}:${this._port}`)
        let connection = net.connect(this._port, this._host);
        connection.setNoDelay(true);
        connection.setKeepAlive(true);
        this._localConnectionCallback = callback;

        // once connected, we need to write the current chunk
        // first before we assign the local connection
        connection.once('connect', () => {
            this._debug(`Connected local to ${this._host}:${this._port}`)
            if (LOG_DATA) {
                this._debug_data('Write ' + chunk.length + ' bytes');
            }
            connection.write(chunk, encoding, callback);
            this._localConnection = connection;
        });

        // we are listening to data events and push them to this stream
        // to make them available upstream.
        connection.on('data', (chunk) => {
            if (LOG_DATA) {
                this._debug_data('Read ' + chunk.length + ' bytes');
            }
            this.push(chunk);
        });

        // make sure we terminate the connection
        // if we get an end, close, or error event
        // from the local connection
        connection.on('close', () => {
            if (this._localConnection != null) {
                this._debug('Local connection close');
                this.end();
            }
        });
        connection.on('end', () => {
            if (this._localConnection != null) {
                this._debug('Local connection end');
                this.end();
            }
        });

        // in case of an error we delegate the error to the callback
        // before we terminate the local connection
        connection.on('error', (err) => {
            this._debug('Closing local connection after error:' + err.message);
            this._closeLocalStream();
            // We need to use the cached callback here to make sure that the
            // callback is the correct one for consecutive write calls
            if (this._localConnectionCallback) {
                this._localConnectionCallback(err);
                this._localConnectionCallback = null;
            }
        });
    }

    // node stream overrides
    end() {
        super.end();
        if (this._open) {
            this._debug('Ending stream');
            this._open = false;
            this._closeLocalStream();
            this.emit('end');
        }
    }

    destroy() {
        super.destroy();
        this._open = false;
        this._closeLocalStream();
    }


    // @push is called when there is data, _read does nothing
    _read() {
    }

    // if callback is not called, then stream write will be blocked
    _write(chunk, encoding, callback) {
        if (!this._open) {
            this._debug('Can not write data. Stream no open.')
            callback(new Error('stream not open'));
            return;
        }

        if (this._localConnection == null) {
            // We have no connection yet so we need to create it here.
            // Any additional calls to write() will be buffered until the
            // callback is triggered. This ensures that we do not need to
            // handle more calls to this until the connection is established
            this._createLocalStream(chunk, encoding, callback);
        } else {
            // we have a local connection and can directly forward the data
            // but make sure we cache the callback here in case an error occurs and
            // the connections error listener needs to fail the callback with the
            // error
            this._localConnectionCallback = callback;
            if (LOG_DATA) {
                this._debug_data('Write ' + chunk.length + ' bytes');
            }
            this._localConnection.write(chunk, encoding, callback);
        }
    }

}

class ServerConnection extends EventEmitter {
    constructor(websocketConnection, id) {
        super();
        this.id = id;
        this.websocketConnection = websocketConnection;
        /**
         * @type {WebsocketStream|null}
         * @private
         */
        this._stream = null;
        this._debug = require('debug')('tl:connection:' + id);

        /**
         * Flag that is true while we are disconnecting from a stream. The
         * stream's end event might be listened to by multiple parties that
         * can also try to trigger the disconnect for cleanup. We use this
         * to make sure that the disconnect is not interrupted.
         *
         * @type {boolean}
         * @private
         */
        this._disconnecting = false;

        // start listening to events on the web socket that indicate its termination
        this.websocketConnection.on('end', this._handleWsEnd.bind(this));
        this.websocketConnection.on('close', this._handleWsClose.bind(this));
        this.websocketConnection.on('error', this._handleWsError.bind(this));
    }

    /**
     * Returns true if the connection is in use and a stream is opened.
     *
     * @returns {boolean}
     */
    connected() {
        return this._stream !== null;
    }

    /**
     * Starts using the websocket for data transfer and returns a new stream
     * that can be used to push binary data through the websocket.
     *
     * @param {boolean} closeWebSocket If true, the websocket can not be reused when the stream ends and will be closed
     * @returns {WebsocketStream|null} The stream or null if the stream could not be created
     */
    connect(closeWebSocket = false) {
        if (this._stream !== null) {
            this._debug('Can not connect. Connection already exists.');
            return null;
        }
        if (this.websocketConnection == null) {
            this._debug('Can not connect. No websocket!');
            return null;
        }

        this._stream = new WebsocketStream(this.websocketConnection, this.id);
        // noinspection JSUnresolvedFunction
        this._stream.once('end', () => {
            if (closeWebSocket) {
                this._debug('Websocket stream ended. Terminating WebSocket.');
                this.destroy();
            } else {
                this._debug('Websocket stream ended. Disconnecting.');
                this._disconnect();
            }
        });
        this.emit('connected');
        return this._stream;
    }

    /**
     * If a stream is connected, end the stream and remove it from this connection.
     * This marks the connection as disconnected and available for another connection
     *
     * @param {boolean} emit Emit the disconnected event
     * @private
     */
    _disconnect(emit = true) {
        if (this._disconnecting || this._stream === null) {
            return;
        }
        this._disconnecting = true;
        this._stream.end();
        // noinspection JSUnresolvedFunction
        this._stream.removeAllListeners();
        this._stream = null;
        this._disconnecting = false;

        if (emit) {
            this.emit('disconnected');
        }
    }

    /**
     * Ends the connection. This ends any connected stream and the
     * web socket that is associated with this connection. The connection can not be
     * used afterwards.
     */
    end() {
        this._disconnect(false);
        if (this.websocketConnection != null) {
            this.websocketConnection.close();
            this.websocketConnection.removeAllListeners();
            this.websocketConnection = null;
            this.emit('end');
        }
    }

    destroy() {
        if (this._stream) {
            this._stream.removeAllListeners();
            this._stream.destroy();
            this._stream = null;
        }
        this.end();
    }

    _handleWsEnd() {
        this._debug('WebSocket connection end');
        this.end();
    }

    _handleWsClose() {
        this._debug('WebSocket connection close');
        this.end();
        this.emit('close')
    }

    _handleWsError(err) {
        this._debug('WebSocket connection error', err);
        this.end();
        this.emit('error', err)
    }

}

exports.ServerConnection = ServerConnection;
exports.WebsocketStream = WebsocketStream;
exports.LocalStream = LocalStream;
exports.COMMANDS = COMMANDS;
exports.createCommand = createCommand;