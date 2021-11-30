#!/usr/bin/env node
const {program} = require('commander');
const {createTunnel} = require("../lib/client");

program.version('1.0');
program.requiredOption("-h, --host <host>", "The tunnel server")
program.option("-H, --host-name <host-name>", "Overwrite the Host: header with this value.");
program.requiredOption("-l, --local-port <port>", "The local port to forward")
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

let tunnel = null;
createTunnel(options.host, options.localPort, options.name, options.hostName).then((t) => {
    tunnel = t;
    console.log('Connect to tunnel using', tunnel.tunnelUrl);
}).catch(e => {
    console.error('Error connecting to tunnel server: ' + e.message);
    process.exit(1);
});