#!/usr/bin/env node
const {program} = require('commander');
const {tunnel} = require("../lib/client");

program.version('1.0');
program.option("-l, --local-port <port>", "The local port to forward")
program.option("-h, --host <host>", "The tunnel server")
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

tunnel(options.host, options.localPort, options.name).then((url) => {
    console.log('Connect to tunnel through:', url);
}).catch(e => {
    console.error(e.message);
    process.exit(1);
});