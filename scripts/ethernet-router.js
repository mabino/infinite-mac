import { WebSocketServer } from 'ws';
import net from 'net';
import http from 'http';
import https from 'https';
import dns from 'dns';
import { URL } from 'url';

const ROUTER_IP = Buffer.from([10, 0, 2, 2]);
const ROUTER_MAC = Buffer.from([0, 5, 2, 0, 0, 1]);
const CLIENT_IP = Buffer.from([10, 0, 2, 15]);

const PROXY_PORT = 8081;
const WS_PORT = 8080;

// Set up the Vintage Web Proxy
const proxyServer = http.createServer((req, res) => {
    console.log(`[PROXY] Request: ${req.method} ${req.url}`);
    
    try {
        let targetUrl = req.url;
        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            // Absolute URI is required, but if relative, reconstruct it using Host header
            targetUrl = 'http://' + req.headers.host + targetUrl;
        }

        // Upgrade HTTP to HTTPS for modern websites
        if (targetUrl.startsWith('http://')) {
            targetUrl = 'https://' + targetUrl.slice(7);
        }

        const parsedUrl = new URL(targetUrl);
        const headers = { ...req.headers };
        
        // Strip proxy-specific headers
        delete headers['proxy-connection'];
        delete headers['connection'];
        headers['host'] = parsedUrl.host;

        const requestOptions = {
            method: req.method,
            headers: headers,
            host: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
        };

        const clientReq = https.request(requestOptions, (clientRes) => {
            const contentType = clientRes.headers['content-type'] || '';
            const isHtml = contentType.toLowerCase().includes('text/html');

            const responseHeaders = { ...clientRes.headers };
            if (isHtml) {
                // Remove content-length since we will modify the body
                delete responseHeaders['content-length'];
                delete responseHeaders['content-security-policy'];
                delete responseHeaders['content-encoding'];
            }

            res.writeHead(clientRes.statusCode, responseHeaders);

            if (isHtml) {
                let body = '';
                clientRes.on('data', (chunk) => {
                    body += chunk.toString('utf8');
                });
                clientRes.on('end', () => {
                    // Strip modern bloated JS, rewrite HTTPS -> HTTP
                    const processed = body
                        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                        .replace(/on\w+="[^"]*"/gi, '') // Remove simple inline handlers
                        .replace(/on\w+='[^']*'/gi, '')
                        .replace(/https:\/\//gi, 'http://');
                    res.end(processed, 'utf8');
                });
            } else {
                clientRes.pipe(res);
            }
        });

        clientReq.on('error', (err) => {
            console.error(`[PROXY] Request Error for ${targetUrl}:`, err);
            res.writeHead(502);
            res.end(`Proxy Error: ${err.message}`);
        });

        req.pipe(clientReq);
    } catch (e) {
        console.error('[PROXY] Exception:', e);
        res.writeHead(500);
        res.end(`Proxy Exception: ${e.message}`);
    }
});

proxyServer.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`[PROXY] Vintage Web Proxy listening on 127.0.0.1:${PROXY_PORT}`);
});


// TCP & IP packet utilities
function checksum(buffer, initial = 0) {
    let sum = initial;
    for (let i = 0; i < buffer.length; i += 2) {
        if (i + 1 < buffer.length) {
            sum += (buffer[i] << 8) | buffer[i + 1];
        } else {
            sum += buffer[i] << 8;
        }
    }
    while (sum >> 16) {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    return (~sum) & 0xffff;
}

function ipChecksum(packet) {
    let sum = 0;
    for (let i = 0; i < 20; i += 2) {
        sum += (packet[i] << 8) | packet[i + 1];
    }
    while (sum >> 16) {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    return (~sum) & 0xffff;
}

function tcpChecksum(srcIp, destIp, tcpPacket) {
    let sum = 0;
    sum += (srcIp[0] << 8) | srcIp[1];
    sum += (srcIp[2] << 8) | srcIp[3];
    sum += (destIp[0] << 8) | destIp[1];
    sum += (destIp[2] << 8) | destIp[3];
    sum += 6; // Protocol TCP
    sum += tcpPacket.length;

    return checksum(tcpPacket, sum);
}

function udpChecksum(srcIp, destIp, udpPacket) {
    let sum = 0;
    sum += (srcIp[0] << 8) | srcIp[1];
    sum += (srcIp[2] << 8) | srcIp[3];
    sum += (destIp[0] << 8) | destIp[1];
    sum += (destIp[2] << 8) | destIp[3];
    sum += 17; // Protocol UDP
    sum += udpPacket.length;

    return checksum(udpPacket, sum);
}

function buildEthernetPacket(srcMac, dstMac, etherType, payload) {
    const header = Buffer.alloc(14);
    dstMac.copy(header, 0);
    srcMac.copy(header, 6);
    header.writeUInt16BE(etherType, 12);
    
    let packet = Buffer.concat([header, payload]);
    if (packet.length < 64) {
        const padding = Buffer.alloc(64 - packet.length, 0);
        packet = Buffer.concat([packet, padding]);
    }
    return packet;
}

function buildIpPacket(srcIp, dstIp, protocol, payload) {
    const ipLen = 20 + payload.length;
    const packet = Buffer.alloc(20);
    packet[0] = 0x45;
    packet[1] = 0x00;
    packet.writeUInt16BE(ipLen, 2);
    packet.writeUInt16BE(0x1234, 4);
    packet.writeUInt16BE(0x4000, 6); // DF
    packet[8] = 64; // TTL
    packet[9] = protocol;
    packet.writeUInt16BE(0, 10);
    
    srcIp.copy(packet, 12);
    dstIp.copy(packet, 16);

    const sum = ipChecksum(packet);
    packet.writeUInt16BE(sum, 10);

    return Buffer.concat([packet, payload]);
}

function buildTcpPacket(srcIp, dstIp, srcPort, dstPort, seq, ack, flags, windowSize, payload = Buffer.alloc(0)) {
    const tcpLen = 20 + payload.length;
    const packet = Buffer.alloc(tcpLen);
    packet.writeUInt16BE(srcPort, 0);
    packet.writeUInt16BE(dstPort, 2);
    packet.writeUInt32BE(seq, 4);
    packet.writeUInt32BE(ack, 8);
    packet[12] = (5 << 4);
    packet[13] = flags;
    packet.writeUInt16BE(windowSize, 14);
    packet.writeUInt16BE(0, 16);
    packet.writeUInt16BE(0, 18);

    if (payload.length > 0) {
        payload.copy(packet, 20);
    }

    const sum = tcpChecksum(srcIp, dstIp, packet);
    packet.writeUInt16BE(sum, 16);

    return packet;
}

// DNS Response helpers
function buildDnsResponse(queryPayload, ips) {
    const transactionId = queryPayload.subarray(0, 2);
    let offset = 12;
    while (offset < queryPayload.length) {
        const len = queryPayload[offset];
        if (len === 0) {
            offset += 1;
            break;
        }
        offset += 1 + len;
    }
    const questionEnd = offset + 4;
    const questionSection = queryPayload.subarray(12, questionEnd);

    const header = Buffer.alloc(12);
    transactionId.copy(header, 0);
    header.writeUInt16BE(ips.length > 0 ? 0x8180 : 0x8183, 2); // standard query response (NXDOMAIN if empty)
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(ips.length, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);

    const parts = [header, questionSection];
    for (const ip of ips) {
        const ipParts = ip.split('.').map(Number);
        const rr = Buffer.alloc(16);
        rr.writeUInt16BE(0xc00c, 0); // Pointer to question name
        rr.writeUInt16BE(1, 2);      // Type A
        rr.writeUInt16BE(1, 4);      // Class IN
        rr.writeUInt32BE(60, 6);     // TTL 60s
        rr.writeUInt16BE(4, 10);     // Length 4
        rr[12] = ipParts[0];
        rr[13] = ipParts[1];
        rr[14] = ipParts[2];
        rr[15] = ipParts[3];
        parts.push(rr);
    }
    return Buffer.concat(parts);
}

function parseDomainName(queryPayload) {
    let offset = 12;
    const parts = [];
    while (offset < queryPayload.length) {
        const len = queryPayload[offset];
        if (len === 0) {
            break;
        }
        const label = queryPayload.toString('ascii', offset + 1, offset + 1 + len);
        parts.push(label);
        offset += 1 + len;
    }
    return parts.join('.');
}

function handleDhcp(udpPayload, clientMac) {
    const op = udpPayload[0];
    if (op !== 1) return null;

    const xid = udpPayload.subarray(4, 8);
    const flags = udpPayload.readUInt16BE(10);
    const chaddr = udpPayload.subarray(28, 34);

    let msgType = 0;
    let offset = 240;
    while (offset < udpPayload.length) {
        const optType = udpPayload[offset];
        if (optType === 255) break;
        if (optType === 0) {
            offset++;
            continue;
        }
        const optLen = udpPayload[offset + 1];
        if (optType === 53) {
            msgType = udpPayload[offset + 2];
        }
        offset += 2 + optLen;
    }

    if (msgType !== 1 && msgType !== 3) {
        return null;
    }

    console.log(`[DHCP] Received DHCP ${msgType === 1 ? 'Discover' : 'Request'} from Mac`);

    const reply = Buffer.alloc(300);
    reply[0] = 2; // BootReply
    reply[1] = 1; // Ethernet
    reply[2] = 6;
    reply[3] = 0;
    xid.copy(reply, 4);
    reply.writeUInt16BE(0, 8);
    reply.writeUInt16BE(flags, 10); // Copy broadcast flag

    CLIENT_IP.copy(reply, 16);
    ROUTER_IP.copy(reply, 20);
    chaddr.copy(reply, 28);
    reply.writeUInt32BE(0x63825363, 236); // Magic Cookie

    let optOffset = 240;
    
    // DHCP Message Type (2 Offer, 5 ACK)
    reply[optOffset++] = 53;
    reply[optOffset++] = 1;
    reply[optOffset++] = (msgType === 1) ? 2 : 5;

    // Server ID
    reply[optOffset++] = 54;
    reply[optOffset++] = 4;
    ROUTER_IP.copy(reply, optOffset);
    optOffset += 4;

    // Subnet Mask
    reply[optOffset++] = 1;
    reply[optOffset++] = 4;
    Buffer.from([255, 255, 255, 0]).copy(reply, optOffset);
    optOffset += 4;

    // Router
    reply[optOffset++] = 3;
    reply[optOffset++] = 4;
    ROUTER_IP.copy(reply, optOffset);
    optOffset += 4;

    // DNS
    reply[optOffset++] = 6;
    reply[optOffset++] = 4;
    ROUTER_IP.copy(reply, optOffset);
    optOffset += 4;

    // Lease Time (86400)
    reply[optOffset++] = 51;
    reply[optOffset++] = 4;
    reply.writeUInt32BE(86400, optOffset);
    optOffset += 4;

    // Renewal Time (43200)
    reply[optOffset++] = 58;
    reply[optOffset++] = 4;
    reply.writeUInt32BE(43200, optOffset);
    optOffset += 4;

    // Rebinding Time (75600)
    reply[optOffset++] = 59;
    reply[optOffset++] = 4;
    reply.writeUInt32BE(75600, optOffset);
    optOffset += 4;

    reply[optOffset++] = 255;

    const dhcpPayload = reply.subarray(0, optOffset);

    const udpLen = 8 + dhcpPayload.length;
    const udpPacket = Buffer.alloc(udpLen);
    udpPacket.writeUInt16BE(67, 0);
    udpPacket.writeUInt16BE(68, 2);
    udpPacket.writeUInt16BE(udpLen, 4);
    udpPacket.writeUInt16BE(0, 6);
    dhcpPayload.copy(udpPacket, 8);

    const BROADCAST_IP = Buffer.from([255, 255, 255, 255]);
    const udpChk = udpChecksum(ROUTER_IP, BROADCAST_IP, udpPacket);
    udpPacket.writeUInt16BE(udpChk, 6);

    const ipPacket = buildIpPacket(ROUTER_IP, BROADCAST_IP, 17, udpPacket);
    const broadcastFlag = (flags & 0x8000) !== 0;
    const destMac = broadcastFlag ? Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : clientMac;

    return buildEthernetPacket(ROUTER_MAC, destMac, 0x0800, ipPacket);
}


// Start the WebSocket NAT Server
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`[WS] Server listening on ws://localhost:${WS_PORT}`);

const connections = new Map();

wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    let clientMac = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const { type, ...payload } = data;
            
            if (type === 'init') {
                console.log(`[WS] Initialized with MAC Address: ${payload.macAddress}`);
                clientMac = Buffer.from(payload.macAddress.split(':').map(x => parseInt(x, 16)));
            } else if (type === 'send') {
                const packet = Buffer.from(payload.packetArray);
                handleIncomingPacket(ws, packet);
            } else if (type === 'log') {
                console.log(`[CLIENT-LOG] ${payload.message}`);
            }
        } catch (e) {
            console.error('[WS] Message handling error:', e);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Client disconnected');
        // Clean up connections
        for (const [key, conn] of connections.entries()) {
            if (conn.socket) {
                conn.socket.destroy();
            }
            connections.delete(key);
        }
    });
});

function handleIncomingPacket(ws, packet) {
    const dstMac = packet.subarray(0, 6);
    const srcMac = packet.subarray(6, 12);
    const etherType = packet.readUInt16BE(12);

    if (etherType === 0x0806) {
        // ARP Request
        const arpPayload = packet.slice(14);
        const opcode = arpPayload.readUInt16BE(6);
        const senderMac = Array.from(arpPayload.subarray(8, 14)).map(x => x.toString(16).padStart(2, '0')).join(':');
        const senderIp = Array.from(arpPayload.subarray(14, 18)).join('.');
        const targetIp = Array.from(arpPayload.subarray(24, 28)).join('.');
        console.log(`[ARP] Opcode: ${opcode}, Sender MAC: ${senderMac}, Sender IP: ${senderIp}, Target IP: ${targetIp}, Request Hex: ${arpPayload.toString('hex')}`);
        
        const reply = handleArp(arpPayload);
        if (reply) {
            console.log(`[ARP] Sending reply for Target IP: ${targetIp}, Hex: ${reply.toString('hex')}`);
            // Send unicast reply
            ws.send(JSON.stringify({
                type: 'receive',
                packetArray: Array.from(reply)
            }));
            // Send broadcast reply (destination MAC: ff:ff:ff:ff:ff:ff)
            const broadcastReply = Buffer.from(reply);
            Buffer.from([255, 255, 255, 255, 255, 255]).copy(broadcastReply, 0);
            ws.send(JSON.stringify({
                type: 'receive',
                packetArray: Array.from(broadcastReply)
            }));
        }
    } else if (etherType === 0x0800) {
        // IPv4 Packet
        const ipHeaderLen = (packet[14] & 0x0f) * 4;
        const protocol = packet[14 + 9];
        const srcIp = packet.subarray(14 + 12, 14 + 16);
        const dstIp = packet.subarray(14 + 16, 14 + 20);
        const srcIpStr = Array.from(srcIp).join('.');
        const dstIpStr = Array.from(dstIp).join('.');

        console.log(`[IPv4] Protocol: ${protocol}, Src: ${srcIpStr}, Dst: ${dstIpStr}`);

        if (protocol === 17) {
            // UDP
            const udpHeaderOffset = 14 + ipHeaderLen;
            const srcPort = packet.readUInt16BE(udpHeaderOffset + 0);
            const dstPort = packet.readUInt16BE(udpHeaderOffset + 2);
            const len = packet.readUInt16BE(udpHeaderOffset + 4);
            const udpPayload = packet.subarray(udpHeaderOffset + 8, udpHeaderOffset + len);

            console.log(`[UDP] Src Port: ${srcPort}, Dst Port: ${dstPort}, Len: ${len}`);

            if (dstPort === 53) {
                // DNS request
                const domain = parseDomainName(udpPayload);
                console.log(`[DNS] Resolving: ${domain}`);
                dns.resolve4(domain, (err, addresses) => {
                    const resolved = err ? [] : addresses;
                    console.log(`[DNS] Resolved: ${domain} -> ${resolved}`);
                    
                    const dnsResp = buildDnsResponse(udpPayload, resolved);
                    const udpLen = 8 + dnsResp.length;
                    
                    const udpPacket = Buffer.alloc(udpLen);
                    udpPacket.writeUInt16BE(53, 0); // Src Port
                    udpPacket.writeUInt16BE(srcPort, 2); // Dst Port
                    udpPacket.writeUInt16BE(udpLen, 4);
                    udpPacket.writeUInt16BE(0, 6); // Checksum
                    dnsResp.copy(udpPacket, 8);
                    
                    const udpChk = udpChecksum(ROUTER_IP, CLIENT_IP, udpPacket);
                    udpPacket.writeUInt16BE(udpChk, 6);
                    
                    const ipPacket = buildIpPacket(ROUTER_IP, CLIENT_IP, 17, udpPacket);
                    const ethPacket = buildEthernetPacket(ROUTER_MAC, srcMac, 0x0800, ipPacket);
                    
                    ws.send(JSON.stringify({
                        type: 'receive',
                        packetArray: Array.from(ethPacket)
                    }));
                });
            } else if (dstPort === 67) {
                // DHCP request
                const reply = handleDhcp(udpPayload, srcMac);
                if (reply) {
                    ws.send(JSON.stringify({
                        type: 'receive',
                        packetArray: Array.from(reply)
                    }));
                }
            }
        } else if (protocol === 6) {
            // TCP
            const tcpHeaderOffset = 14 + ipHeaderLen;
            const srcPort = packet.readUInt16BE(tcpHeaderOffset + 0);
            const dstPort = packet.readUInt16BE(tcpHeaderOffset + 2);
            const seq = packet.readUInt32BE(tcpHeaderOffset + 4);
            const ack = packet.readUInt32BE(tcpHeaderOffset + 8);
            const dataOffset = (packet[tcpHeaderOffset + 12] >> 4) * 4;
            const flags = packet[tcpHeaderOffset + 13];
            const tcpPayload = packet.subarray(tcpHeaderOffset + dataOffset);

            const srcIpStr = Array.from(srcIp).join('.');
            const dstIpStr = Array.from(dstIp).join('.');
            const connectionKey = `${srcIpStr}:${srcPort}->${dstIpStr}:${dstPort}`;

            let conn = connections.get(connectionKey);

            if (!conn) {
                if (flags & 0x02) { // SYN
                    console.log(`[TCP] Connection SYN from Mac ${srcIpStr}:${srcPort} -> ${dstIpStr}:${dstPort}`);
                    
                    conn = {
                        state: 'SYN_RECEIVED',
                        clientMac: Buffer.from(srcMac),
                        clientIp: Buffer.from(srcIp),
                        dstIp: Buffer.from(dstIp),
                        srcPort: srcPort,
                        dstPort: dstPort,
                        clientSeq: seq,
                        clientAck: ack,
                        serverSeq: Math.floor(Math.random() * 100000),
                        serverAck: (seq + 1) >>> 0,
                        socket: null,
                        bufferedData: [],
                        ws: ws
                    };
                    connections.set(connectionKey, conn);

                    // Send SYN-ACK
                    const tcpPacket = buildTcpPacket(
                        conn.dstIp, conn.clientIp,
                        conn.dstPort, conn.srcPort,
                        conn.serverSeq, conn.serverAck,
                        0x12, // SYN | ACK
                        65535
                    );
                    const ipPacket = buildIpPacket(conn.dstIp, conn.clientIp, 6, tcpPacket);
                    const ethPacket = buildEthernetPacket(ROUTER_MAC, conn.clientMac, 0x0800, ipPacket);
                    
                    ws.send(JSON.stringify({
                        type: 'receive',
                        packetArray: Array.from(ethPacket)
                    }));
                    conn.serverSeq = (conn.serverSeq + 1) >>> 0;

                    // Establish real connection to the target/proxy
                    const isProxyRequest = (dstIpStr === '10.0.2.2' && dstPort === 8080) || dstPort === 80;
                    const realPort = isProxyRequest ? PROXY_PORT : dstPort;
                    const realHost = isProxyRequest ? '127.0.0.1' : dstIpStr;

                    console.log(`[TCP] Connecting proxy socket to ${realHost}:${realPort}`);
                    
                    const socket = net.connect({ host: realHost, port: realPort }, () => {
                        console.log(`[TCP] Real destination socket connected for ${connectionKey}`);
                        conn.state = 'ESTABLISHED';
                        for (const d of conn.bufferedData) {
                            socket.write(d);
                        }
                        conn.bufferedData = [];
                    });

                    socket.on('data', (chunk) => {
                        console.log(`[TCP] Data from real destination for ${connectionKey}: ${chunk.length} bytes`);
                        const tcpP = buildTcpPacket(
                            conn.dstIp, conn.clientIp,
                            conn.dstPort, conn.srcPort,
                            conn.serverSeq, conn.serverAck,
                            0x18, // PSH | ACK
                            65535,
                            chunk
                        );
                        const ipP = buildIpPacket(conn.dstIp, conn.clientIp, 6, tcpP);
                        const ethP = buildEthernetPacket(ROUTER_MAC, conn.clientMac, 0x0800, ipP);
                        
                        ws.send(JSON.stringify({
                            type: 'receive',
                            packetArray: Array.from(ethP)
                        }));
                        conn.serverSeq = (conn.serverSeq + chunk.length) >>> 0;
                    });

                    socket.on('end', () => {
                        console.log(`[TCP] Socket ended by real destination for ${connectionKey}`);
                        sendFin(conn);
                    });

                    socket.on('error', (err) => {
                        console.error(`[TCP] Socket error for ${connectionKey}:`, err);
                        sendRst(conn);
                    });

                    conn.socket = socket;
                }
            } else {
                // Update connection state
                conn.clientSeq = seq;
                conn.clientAck = ack;

                if (flags & 0x04) { // RST
                    console.log(`[TCP] RST received from client for ${connectionKey}`);
                    if (conn.socket) conn.socket.destroy();
                    connections.delete(connectionKey);
                    return;
                }

                if (flags & 0x01) { // FIN
                    console.log(`[TCP] FIN received from client for ${connectionKey}`);
                    conn.serverAck = (conn.serverAck + 1) >>> 0;
                    // Acknowledge FIN
                    sendAck(conn);
                    if (conn.socket) conn.socket.end();
                    connections.delete(connectionKey);
                    return;
                }

                if (tcpPayload.length > 0) {
                    console.log(`[TCP] Payload from client for ${connectionKey}: ${tcpPayload.length} bytes`);
                    conn.serverAck = (conn.serverAck + tcpPayload.length) >>> 0;
                    
                    if (conn.state === 'ESTABLISHED' && conn.socket) {
                        conn.socket.write(tcpPayload);
                    } else {
                        conn.bufferedData.push(tcpPayload);
                    }

                    // Acknowledge receipt of payload
                    sendAck(conn);
                }
            }
        }
    }
}

function sendAck(conn) {
    const tcpPacket = buildTcpPacket(
        conn.dstIp, conn.clientIp,
        conn.dstPort, conn.srcPort,
        conn.serverSeq, conn.serverAck,
        0x10, // ACK
        65535
    );
    const ipPacket = buildIpPacket(conn.dstIp, conn.clientIp, 6, tcpPacket);
    const ethPacket = buildEthernetPacket(ROUTER_MAC, conn.clientMac, 0x0800, ipPacket);
    conn.ws.send(JSON.stringify({
        type: 'receive',
        packetArray: Array.from(ethPacket)
    }));
}

function sendFin(conn) {
    const tcpPacket = buildTcpPacket(
        conn.dstIp, conn.clientIp,
        conn.dstPort, conn.srcPort,
        conn.serverSeq, conn.serverAck,
        0x11, // FIN | ACK
        65535
    );
    const ipPacket = buildIpPacket(conn.dstIp, conn.clientIp, 6, tcpPacket);
    const ethPacket = buildEthernetPacket(ROUTER_MAC, conn.clientMac, 0x0800, ipPacket);
    conn.ws.send(JSON.stringify({
        type: 'receive',
        packetArray: Array.from(ethPacket)
    }));
    conn.serverSeq = (conn.serverSeq + 1) >>> 0;
}

function sendRst(conn) {
    const tcpPacket = buildTcpPacket(
        conn.dstIp, conn.clientIp,
        conn.dstPort, conn.srcPort,
        conn.serverSeq, conn.serverAck,
        0x04, // RST
        0
    );
    const ipPacket = buildIpPacket(conn.dstIp, conn.clientIp, 6, tcpPacket);
    const ethPacket = buildEthernetPacket(ROUTER_MAC, conn.clientMac, 0x0800, ipPacket);
    conn.ws.send(JSON.stringify({
        type: 'receive',
        packetArray: Array.from(ethPacket)
    }));
    connections.delete(`${Array.from(conn.clientIp).join('.')}:${conn.srcPort}->${Array.from(conn.dstIp).join('.')}:${conn.dstPort}`);
}

function handleArp(arpPayload) {
    const opcode = arpPayload.readUInt16BE(6);
    if (opcode !== 1) return null;

    const senderMac = arpPayload.subarray(8, 14);
    const senderIp = arpPayload.subarray(14, 18);
    const targetIp = arpPayload.subarray(24, 28);

    if (targetIp.equals(ROUTER_IP)) {
        const reply = Buffer.alloc(28);
        reply.writeUInt16BE(1, 0);
        reply.writeUInt16BE(0x0800, 2);
        reply[4] = 6;
        reply[5] = 4;
        reply.writeUInt16BE(2, 6); // reply

        ROUTER_MAC.copy(reply, 8);
        ROUTER_IP.copy(reply, 14);
        senderMac.copy(reply, 18);
        senderIp.copy(reply, 24);

        return buildEthernetPacket(ROUTER_MAC, senderMac, 0x0806, reply);
    }
    return null;
}
