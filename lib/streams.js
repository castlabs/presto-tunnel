const stream = require('stream');
const WebSocketConnection = require('websocket').connection;
const EventEmitter = require('events');


/**
 * WebSocket stream that takes an existing websocket connection and
 * uses that to read and write data as part of a duplex stream. When the
 * stream ends, the web socket connection is not terminated or closed so
 * that it can be used for another stream.
 */
class ServerWsStream extends stream.Duplex {
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
        this._debug = require('debug')('tl:stream:' + id);
        /**
         * Logger for data transmission
         * @private
         */
        this._debug_data = require('debug')('tl:stream:' + id + ':data');
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

        // Initialize the stream by listening to message on the web socket
        // noinspection JSUnresolvedFunction
        this.ws.on('message', this._messageHandler);
    }


    /**
     * Disconnects the stream from the web socket and stops listening to messages.
     *
     * @private
     */
    _disconnect() {
        // noinspection JSUnresolvedFunction
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
            if(message.utf8Data ==='tcp-terminated') {
                this._debug('Client Side TCP connection terminated');
                this.end();
            } else if(message.utf8Data ==='END') {
                this._debug('Server Side requested connection termination');
                this.emit('terminate');
            } else {
                try {
                    let msg = JSON.parse(message.utf8Data);
                    if (msg && msg.error) {
                        // received an error message from down stream connection.
                        this._debug('Ending stream after receiving remote error: ' + msg.error);
                        this.end();
                    }
                }catch {
                    this._debug('Do not know how to handle message: ' + message.utf8Data);
                }
            }
        } else if (message.type === 'binary') {
            this._debug_data('Read ' + message.binaryData.length + ' bytes');
            if(this._open) {
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
            this.ws.sendUTF('END', () => {
                this.end();
            });
        }
    }

    // node stream overrides
    end() {
        super.end();
        // emit an end event but make sure that we are NOT closing the WS socket since
        // we want to reuse that one.
        if(this._open) {
            this._debug('Closing stream');
            this._open = false;
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
            this._debug_data('Write ' + chunk.length + ' bytes');
            return this.ws.sendBytes(chunk, callback);
        } else {
            this._debug('Can not write data. Stream no open.')
            callback(new Error('Stream is not open!'));
        }
    }
}

class ServerConnection extends EventEmitter {
    constructor(websocketConnection, id) {
        super();
        this.id = id;
        this.websocketConnection = websocketConnection;
        /**
         * @type {ServerWsStream|null}
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
     * @returns {ServerWsStream|null} The stream or null if the stream could not be created
     */
    connect(closeWebSocket=false) {
        if(this._stream !== null) {
            this._debug('Can not connect. Connection already exists.');
            return null;
        }
        if (this.websocketConnection == null) {
            this._debug('Can not connect. No websocket!');
            return null;
        }

        this._stream = new ServerWsStream(this.websocketConnection, this.id);
        // noinspection JSUnresolvedFunction
        this._stream.once('end', () => {
            if(closeWebSocket) {
                this._debug('Stream ended. Terminating WebSocket.');
                this.end();
            } else {
                this._debug('Stream ended. Disconnecting stream.');
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
    _disconnect(emit=true) {
        if(this._disconnecting || this._stream === null) {
            return;
        }
        this._disconnecting = true;
        this._stream.end();
        // noinspection JSUnresolvedFunction
        this._stream.removeAllListeners();
        this._stream = null;
        this._disconnecting = false;

        if(emit) {
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
exports.ServerWsStream = ServerWsStream;