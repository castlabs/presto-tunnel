#!/usr/bin/env node
const {program} = require('commander');
const {createTunnel} = require("../lib/client");

program.version('1.0');
program.requiredOption("-h, --host <host>", "The tunnel server")
program.option("-H, --host-name <host-name>", "Overwrite the Host: header with this value.");
program.requiredOption("-l, --local-port <port>", "The local port to forward")
program.option("-L, --local-host <host>", "The local host to connect to. Defaults to 127.0.0.1", "127.0.0.1")
program.option("--local-name <local-name>", "The host name that will be injected when forwarding requests")
program.option("-n, --name <name>", "preferred tunnel name")
program.parse(process.argv);

const options = program.opts();

if(!options.host) {
    console.error('Please specify a URL to the tunnel server')
    process.exit(1);
}
if(!options.localPort) {
    console.error('Please specify the local port to connect to')
    process.exit(1);
}

const tunnel = createTunnel({
    tunnelHost: options.host,
    localPort: options.localPort,
    localHost: options.localHost,
    localName: options.localName,
    preferredName: options.name,
    hostName: options.hostName
});

tunnel.on('connected', (tunnelUrl) => {
    console.log('Connect to tunnel using', tunnelUrl);
});

tunnel.on('error', (error) => {
    console.error('Error connecting to tunnel server: ' + error.message);
    process.exit(1);
});

tunnel.on('request', (id, req) => {
    console.log(new Date(), `> ${id} ${req.method} ${req.path}`)
});

tunnel.on('response', (id, res) => {
    console.log(new Date(), `< ${id} ${res.method} ${res.path} ${res.statusCode || '-'}`)
});

tunnel.connect();