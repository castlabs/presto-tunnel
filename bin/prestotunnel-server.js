#!/usr/bin/env node
const {program} = require('commander');
const {startServer} = require("../lib/server");

program.version('1.0');
program.option("-p, --port <port>", "The server port", 8085);
program.option("-h, --host <host>", "The server host name, i.e. tunnel.example.com", "");
program.option("--non-secure", "Use http instead of https as the scheme for the tunnel sever", false);
program.option("--sub-domains", "Use sub-domains instead of <name>- prefix", false);
program.parse(process.argv);

const options = program.opts();
if(options.host === '') {
    console.error('Please specify a server name (without the scheme)')
    process.exit(1);
}
if(options.host.startsWith("http://") || options.host.startsWith("https://")) {
    console.error('Please do not use a scheme when specifying the server name!')
    process.exit(1);
}

startServer(options.host, options.port, options.nonSecure ? 'http' : 'https', options.subDomains)
