// npm test is offline by default. This preload is not a test case.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {syncBuiltinESMExports} from 'node:module';
const deny=()=>{throw Error('TEST_NETWORK_FORBIDDEN');};
globalThis.fetch=deny;
http.request=http.get=https.request=https.get=deny;
net.connect=net.createConnection=tls.connect=deny;
net.Socket.prototype.connect=deny;
syncBuiltinESMExports();
