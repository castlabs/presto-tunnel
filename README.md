# Tunnel Server and Client

This repository contains the server and client code to create a local
tunnel to expose a port on a local machine through a reachable web-server. 

While there are a lot of similar projects out there, and the code for this project 
was inspired by [Localtunnel](https://github.com/localtunnel/localtunnel), none of them was 
doing exactly what we needed. 

The primary use-case and why this project exists in the first place, is to be able to 
run Javascript test, in our case karma tests, on a selenium grid while the karma server
runs in a docker container somewhere on a CI machine. The selenium node has no easy way to 
reach the karma server, and we do not want to create a larger than necessary network setup.

What the tunnel server permits us to do is to dynamically create a tunnel, get a URL that 
is accessible from all selenium nodes, and integrate it as a karma upstream proxy. This way,
the selenium nodes are able to reach the test sources through a proper URL.

The tunnel forwards one port from the client machine and makes that available for http requests.
Note that this is not intended to be a full blow TCP port forward but rather focuses on http
request. Also note that WebSocket connections are currently not supported, i.e. the upgrade 
will fail.

The forwarding is done through a number of web socket connections, so no other ports need to 
be opened on the server side.

## Installation 

You can install the server globally:

```bash
npm install -g https://github.com/castlabs/client_tunnel 
```

## The Server

For the server to operate properly, you need to have a wildcard setup for DNS so generated host
names are properly resolved. Run the server as follows:

```bash
#> tunnel_server -h tunnel.players.castlabs.com -p 8085
```

The above will start the server and assume that the server name is `tunnel.players.castlabs.com`.
The server name is important and needs to match the host name on which requests come in. When
a client connects the server will then create a host name such as `loud-frog-84-tunnel.players.castlabs.com` 
that can be used to access to the exposed port on the client. Note that this is not a sub domain
but rather a prefix. This is the default since it makes it easier for our case to deal with 
wildcard SSL certificates. You can pass `--sub-domains` to the server to let the generated 
names be sub-domains of the tunnel server, i.e. `loud-frog-84.tunnel.players.castlabs.com` in 
our previous example.

## The Client

The tunnel client can be started either as a CLI tool or imported as a module to create 
a tunnel as part of a script. From the command line:

```bash
tunnel -h https://tunnel.players.castlabs.com -l 9000
```

This will establish a connection to the specified tunnel server and expose the local port 9000.