import { WebSocketServer } from 'ws';
import net from 'net';
import http from 'http';
import https from 'https';
import dns from 'dns';
import { URL } from 'url';
import zlib from 'zlib';

function isPrivateIP(ip) {
    if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('169.254.')) return true;
    if (ip.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) return true;
    return false;
}

const ROUTER_IP = Buffer.from([192, 168, 1, 1]);
const ROUTER_MAC = Buffer.from([0xb2, 0x05, 0x02, 0x00, 0x00, 0x01]);
const CLIENT_IP = Buffer.from([192, 168, 1, 15]);

const PROXY_PORT = 8081;
const WS_PORT = 8080;

function sendPacket(ws, packet, delayMs = 20) {
    setTimeout(() => {
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'receive',
                packetArray: Array.from(packet)
            }));
        }
    }, delayMs);
}

// Set up the Vintage Web Proxy
const proxyServer = http.createServer((req, res) => {
    console.log(`[PROXY] Request: ${req.method} ${req.url}`);
    
    try {
        let targetUrl = req.url;
        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            // Absolute URI is required, but if relative, reconstruct it using Host header
            targetUrl = 'http://' + req.headers.host + targetUrl;
        }

        // Intercept Netscape/Mozilla/MCOM startup/welcome/homepages to avoid massive modern page load/redirect loop hangs
        if (targetUrl.includes('netscape.com') || targetUrl.includes('mcom.com') || targetUrl.includes('mozilla.org')) {
            console.log(`[PROXY] Intercepting Netscape homepage request to prevent freeze: ${targetUrl}`);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<html>
<head>
<title>Welcome to Infinite Mac Networking</title>
</head>
<body bgcolor="#FFFFFF" text="#000000">
<center>
  <h1>Welcome to Infinite Mac!</h1>
  <p>Your vintage emulator network connection is active and working.</p>
  <hr width="80%">
  <table border="1" cellpadding="10" cellspacing="0" width="80%">
    <tr bgcolor="#E0E0E0">
      <td><b>Vintage-Friendly Sites to Try:</b></td>
    </tr>
    <tr>
      <td>
        <ul>
          <li><a href="http://wiby.me">Wiby (Retro Search Engine)</a></li>
          <li><a href="http://neverssl.com">NeverSSL (Plaintext Test Site)</a></li>
          <li><a href="http://text.npr.org">NPR Plaintext News</a></li>
          <li><a href="http://news.ycombinator.com">Hacker News</a></li>
          <li><a href="http://google.com">Google (Proxy-cleaned Search)</a></li>
          <li><a href="http://macintoshgarden.org">Macintosh Garden</a></li>
        </ul>
      </td>
    </tr>
  </table>
</center>
</body>
</html>
`);
            return;
        }

        // Upgrade HTTP to HTTPS for modern websites
        if (targetUrl.startsWith('http://')) {
            targetUrl = 'https://' + targetUrl.slice(7);
        }

        const parsedUrl = new URL(targetUrl);
        let upstreamHost = parsedUrl.hostname;
        if (upstreamHost.endsWith('.')) {
            upstreamHost = upstreamHost.slice(0, -1);
        }

        const headers = { ...req.headers };
        
        // Strip proxy-specific and compression headers
        delete headers['proxy-connection'];
        delete headers['connection'];
        delete headers['accept-encoding']; // Request uncompressed data from upstream if possible
        headers['host'] = upstreamHost + (parsedUrl.port ? `:${parsedUrl.port}` : '');

        const requestOptions = {
            method: req.method,
            headers: headers,
            host: upstreamHost,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            servername: upstreamHost, // Explicitly specify SNI without trailing dot
            rejectUnauthorized: false, // Bypass certificate validation errors for legacy/retro sites
            timeout: 15000, // 15s timeout to prevent infinite hangs
        };

        const clientReq = https.request(requestOptions, (clientRes) => {
            const contentType = clientRes.headers['content-type'] || '';
            const isHtml = contentType.toLowerCase().includes('text/html');

            const responseHeaders = { ...clientRes.headers };
            if (responseHeaders['location']) {
                console.log(`[PROXY] Rewriting Location header: ${responseHeaders['location']}`);
                responseHeaders['location'] = responseHeaders['location'].replace(/^https:\/\//i, 'http://');
            }

            const encoding = clientRes.headers['content-encoding'];
            const needsDecompression = encoding === 'gzip' || encoding === 'deflate' || encoding === 'br';

            if (needsDecompression || isHtml) {
                // Remove content-length and encoding headers since the response body is being modified/decompressed
                delete responseHeaders['content-length'];
                delete responseHeaders['content-encoding'];
            }
            if (isHtml) {
                delete responseHeaders['content-security-policy'];
            }

            res.writeHead(clientRes.statusCode, responseHeaders);

            // Handle decompression based on content-encoding
            let responseStream = clientRes;
            if (encoding === 'gzip') {
                responseStream = clientRes.pipe(zlib.createGunzip());
            } else if (encoding === 'deflate') {
                responseStream = clientRes.pipe(zlib.createInflate());
            } else if (encoding === 'br') {
                responseStream = clientRes.pipe(zlib.createBrotliDecompress());
            }

            // Stream error handling to prevent socket hangs
            responseStream.on('error', (err) => {
                console.error('[PROXY] Stream Error:', err);
                if (!res.writableEnded) {
                    res.end();
                }
            });

            if (isHtml) {
                let body = '';
                responseStream.on('data', (chunk) => {
                    body += chunk.toString('utf8');
                });
                responseStream.on('end', () => {
                    // Strip modern bloated JS/CSS and rewrite HTTPS -> HTTP
                    const processed = body
                        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
                        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
                        .replace(/on\w+="[^"]*"/gi, '') // Remove simple inline handlers
                        .replace(/on\w+='[^']*'/gi, '')
                        .replace(/https:\/\//gi, 'http://');
                    res.end(processed, 'utf8');
                });
            } else {
                responseStream.pipe(res);
            }
        });

        clientReq.on('timeout', () => {
            console.error(`[PROXY] Request Timeout for ${targetUrl}`);
            clientReq.destroy();
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

    // Lease Time (Infinite: 0xffffffff)
    reply[optOffset++] = 51;
    reply[optOffset++] = 4;
    reply.writeUInt32BE(0xffffffff, optOffset);
    optOffset += 4;

    reply[optOffset++] = 255;

    const dhcpPayload = reply;

    const udpLen = 8 + dhcpPayload.length;
    const udpPacket = Buffer.alloc(udpLen);
    udpPacket.writeUInt16BE(67, 0);
    udpPacket.writeUInt16BE(68, 2);
    udpPacket.writeUInt16BE(udpLen, 4);
    udpPacket.writeUInt16BE(0, 6);
    dhcpPayload.copy(udpPacket, 8);

    // Always use broadcast destination for DHCP replies.
    // Some vintage IP stacks (like Open Transport) drop unicast IP packets destined for the leased IP
    // before the lease is fully bound and configured on the interface.
    const destMac = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const destIp = Buffer.from([255, 255, 255, 255]);

    const udpChk = udpChecksum(ROUTER_IP, destIp, udpPacket);
    udpPacket.writeUInt16BE(udpChk, 6);

    const ipPacket = buildIpPacket(ROUTER_IP, destIp, 17, udpPacket);

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

    // Log ALL non-AppleTalk packets with full hex for debugging
    if (etherType !== 0x000c && etherType !== 0x80f3 && etherType !== 0x809b) {
        const dstMacStr = Array.from(dstMac).map(x => x.toString(16).padStart(2, '0')).join(':');
        const srcMacStr = Array.from(srcMac).map(x => x.toString(16).padStart(2, '0')).join(':');
        console.log(`[PKT-IN] EtherType=0x${etherType.toString(16).padStart(4, '0')} src=${srcMacStr} dst=${dstMacStr} len=${packet.length} hex=${packet.toString('hex').substring(0, 200)}`);
    }

    if (etherType === 0x0806) {
        // ARP Request
        const arpPayload = packet.slice(14);
        const opcode = arpPayload.readUInt16BE(6);
        const senderMac = Array.from(arpPayload.subarray(8, 14)).map(x => x.toString(16).padStart(2, '0')).join(':');
        const senderIp = Array.from(arpPayload.subarray(14, 18)).join('.');
        const targetIp = Array.from(arpPayload.subarray(24, 28)).join('.');
        console.log(`[ARP] Opcode: ${opcode}, Sender MAC: ${senderMac}, Sender IP: ${senderIp}, Target IP: ${targetIp}, Request Hex: ${arpPayload.toString('hex')}`);
        
        const arpReplyPayload = handleArp(arpPayload);
        if (arpReplyPayload) {
            console.log(`[ARP] Sending standard unicast and broadcast replies (64 bytes) for Target IP: ${targetIp}`);
            
            if (ws.readyState === 1) {
                // Build Ethernet Headers
                 const broadcastHeader = Buffer.alloc(14);
                 broadcastHeader.fill(0xff, 0, 6); // destination = broadcast
                 ROUTER_MAC.copy(broadcastHeader, 6); // source = ROUTER_MAC
                 broadcastHeader.writeUInt16BE(0x0806, 12);

                 // Build 42-byte unpadded packet (14 header + 28 payload)
                 const broadcastPkt = Buffer.concat([
                     broadcastHeader, 
                     arpReplyPayload
                 ]);

                 console.log(`[ARP-OUT] Queueing broadcast reply hex (${broadcastPkt.length}B): ${broadcastPkt.toString('hex')} with 200ms delay`);
                 sendPacket(ws, broadcastPkt, 200);

                 // After ARP reply, proactively send a gratuitous ARP from the router
                 // so the guest also has OUR MAC in its ARP cache
                 const gratuitousArp = Buffer.alloc(28);
                 gratuitousArp.writeUInt16BE(0x0001, 0); // HTYPE: Ethernet
                 gratuitousArp.writeUInt16BE(0x0800, 2); // PTYPE: IPv4
                 gratuitousArp[4] = 6; // HLEN
                 gratuitousArp[5] = 4; // PLEN
                 gratuitousArp.writeUInt16BE(2, 6); // OPER: Reply
                 ROUTER_MAC.copy(gratuitousArp, 8); // Sender MAC
                 ROUTER_IP.copy(gratuitousArp, 14); // Sender IP
                 srcMac.copy(gratuitousArp, 18); // Target MAC
                 CLIENT_IP.copy(gratuitousArp, 24); // Target IP

                 const gratArpHeader = Buffer.alloc(14);
                 gratArpHeader.fill(0xff, 0, 6); // broadcast
                 ROUTER_MAC.copy(gratArpHeader, 6);
                 gratArpHeader.writeUInt16BE(0x0806, 12);
                 const gratArpPkt = Buffer.concat([gratArpHeader, gratuitousArp]);
                 console.log(`[ARP-OUT] Sending gratuitous ARP from router`);
                 sendPacket(ws, gratArpPkt, 500);

                 // Proactively send ICMP echo request to the guest after 1.5 seconds
                 // This tests if the guest IP stack can RESPOND to incoming IP traffic
                 setTimeout(() => {
                     if (ws.readyState === 1) {
                         const icmpPayload = Buffer.alloc(8);
                         icmpPayload[0] = 8; // Type: Echo Request
                         icmpPayload[1] = 0; // Code: 0
                         icmpPayload.writeUInt16BE(0, 2); // Checksum placeholder
                         icmpPayload.writeUInt16BE(0x1234, 4); // Identifier
                         icmpPayload.writeUInt16BE(1, 6); // Sequence Number
                         // Calculate ICMP checksum
                         const icmpSum = checksum(icmpPayload);
                         icmpPayload.writeUInt16BE(icmpSum, 2);

                         const ipPacket = buildIpPacket(ROUTER_IP, CLIENT_IP, 1, icmpPayload); // Protocol 1 = ICMP
                         const ethPacket = buildEthernetPacket(ROUTER_MAC, srcMac, 0x0800, ipPacket);
                         console.log(`[ICMP-PROBE] Sending proactive ICMP echo request to guest (${ethPacket.length}B): ${ethPacket.toString('hex')}`);
                         sendPacket(ws, ethPacket, 0);
                     }
                 }, 1500);
            }
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
                    
                    sendPacket(ws, ethPacket);
                });
            } else if (dstPort === 67) {
                // DHCP request
                const reply = handleDhcp(udpPayload, srcMac);
                if (reply) {
                    sendPacket(ws, reply);
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
                    
                    sendPacket(ws, ethPacket);
                    conn.serverSeq = (conn.serverSeq + 1) >>> 0;

                    // Establish real connection to the target/proxy
                    const isProxyRequest = (dstIpStr === '192.168.1.1' && dstPort === 8080) || dstPort === 80;
                    const realPort = isProxyRequest ? PROXY_PORT : dstPort;
                    const realHost = isProxyRequest ? '127.0.0.1' : dstIpStr;

                    if (!isProxyRequest && isPrivateIP(realHost)) {
                        console.warn(`[SECURITY] Blocked proxy attempt to private host: ${realHost}:${realPort}`);
                        sendRst(conn);
                        return;
                    }

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
                        const MSS = 1460;
                        let offset = 0;
                        while (offset < chunk.length) {
                            const size = Math.min(chunk.length - offset, MSS);
                            const segment = chunk.subarray(offset, offset + size);
                            
                            const tcpP = buildTcpPacket(
                                conn.dstIp, conn.clientIp,
                                conn.dstPort, conn.srcPort,
                                conn.serverSeq, conn.serverAck,
                                0x18, // PSH | ACK
                                65535,
                                segment
                            );
                            const ipP = buildIpPacket(conn.dstIp, conn.clientIp, 6, tcpP);
                            const ethP = buildEthernetPacket(ROUTER_MAC, conn.clientMac, 0x0800, ipP);
                            
                            sendPacket(ws, ethP);
                            conn.serverSeq = (conn.serverSeq + size) >>> 0;
                            offset += size;
                        }
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
        } else if (protocol === 1) {
            // ICMP
            const icmpOffset = 14 + ipHeaderLen;
            const icmpPayload = packet.subarray(icmpOffset);
            const icmpType = icmpPayload[0];
            const icmpCode = icmpPayload[1];
            
            console.log(`[ICMP] Type: ${icmpType}, Code: ${icmpCode}`);
            
            if (icmpType === 8) { // Echo Request
                console.log(`[ICMP] Received Echo Request from Mac, replying...`);
                const replyPayload = Buffer.from(icmpPayload);
                replyPayload[0] = 0; // Type: 0 (Echo Reply)
                
                // Recalculate ICMP checksum
                replyPayload.writeUInt16BE(0, 2);
                const icmpChk = checksum(replyPayload);
                replyPayload.writeUInt16BE(icmpChk, 2);
                
                const ipPacket = buildIpPacket(ROUTER_IP, srcIp, 1, replyPayload);
                const ethPacket = buildEthernetPacket(ROUTER_MAC, srcMac, 0x0800, ipPacket);
                
                sendPacket(ws, ethPacket);
            }
        }
    } else {
        const dstMacStr = Array.from(dstMac).map(x => x.toString(16).padStart(2, '0')).join(':');
        const srcMacStr = Array.from(srcMac).map(x => x.toString(16).padStart(2, '0')).join(':');
        console.log(`[Ethernet] Unknown EtherType: 0x${etherType.toString(16).padStart(4, '0')} from ${srcMacStr} to ${dstMacStr}`);
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
    sendPacket(conn.ws, ethPacket);
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
    sendPacket(conn.ws, ethPacket);
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
    sendPacket(conn.ws, ethPacket);
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

        return reply;
    }
    return null;
}
