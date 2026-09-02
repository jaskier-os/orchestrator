# The phone's chat connection stalling with VPN off

> **Update after deploying the fix below.** The dead-socket accumulation was
> real and is fixed, but it was a *consequence*, not the whole cause. A second
> capture taken afterwards shows the remaining stall is in the network path,
> not in our code. See "Second finding" at the end -- read that before changing
> any more application code.


The remote-session chat on the phone dropped its connection roughly every 30-60
seconds whenever the phone's VPN was off. Messages sent during a stall vanished
silently, and a long-running tool would tick forever because the frame saying it
had finished never arrived.

## Root cause: the orchestrator never reaped dead WebSockets

The `ws` library does not detect a peer that disappears without a clean close --
a phone losing its network, a NAT dropping the mapping, a process being killed.
Every one of those leaves a socket the server still considers ESTABLISHED, and
the server keeps writing to it. Nothing in `src/index.js` pinged clients or
called `terminate()`, so those sockets accumulated without limit.

The phone, meanwhile, kept closing and reopening its connection. Each close left
the socket in FIN-WAIT-1: the phone had sent FIN and was waiting for an ACK from
a server that was not reading that socket any more. Its writes -- including the
user's messages -- sat unsent in the send queue.

This is our bug. It is not the ISP, not the router, not Russia, and not the
WebSocket protocol.

## Evidence

Captured with `tcpdump` on the server (`enp41s0`, the public interface),
2026-09-02, phone VPN off, phone's public IP `95.221.46.222`.

**1. The server had accumulated 150 connections from one phone.**

```
# on the server
$ ss -tn state all | grep '95.221.46.222' | awk '{print $1}' | sort | uniq -c
    150 ESTAB
```

The phone, at the same moment, held nine:

```
# on the phone
$ ss -tn | grep 65.108
FIN-WAIT-1  0  210  192.168.0.103:60076  ->  65.108.225.44:8443
FIN-WAIT-1  0  456  192.168.0.103:39270  ->  65.108.225.44:8443
FIN-WAIT-1  0  148  192.168.0.103:58614  ->  65.108.225.44:8443
FIN-WAIT-1  0  183  192.168.0.103:52348  ->  65.108.225.44:8443
FIN-WAIT-1  0  ...  192.168.0.103:34478  ->  65.108.225.44:8443
ESTAB       0  0    192.168.0.103:44108  ->  65.108.225.44:8443
```

Six in FIN-WAIT-1, each with unsent bytes still queued (210, 456, 148, 183).
Those are the user's messages, written into a socket the server had stopped
reading.

**2. The server was retransmitting into a peer that never answered.**

From `/tmp/phone2.pcap`, connection on phone port 36858 -- the same 24-byte
payload resent at 0.28s, 0.5s, 1.0s, 2.0s (exponential backoff, no ACK):

```
1788356775.954380 IP 65.108.225.44.8443 > 95.221.46.222.36858: len=24
1788356776.214389 IP 65.108.225.44.8443 > 95.221.46.222.36858: len=24
1788356776.722389 IP 65.108.225.44.8443 > 95.221.46.222.36858: len=24
1788356777.746395 IP 65.108.225.44.8443 > 95.221.46.222.36858: len=24
1788356779.794391 IP 65.108.225.44.8443 > 95.221.46.222.36858: len=24
```

**3. A healthy connection in the same capture looked completely different.**
Phone port 55206, the 5-second health cycle, every frame acknowledged:

```
phone  -> server  len=49   (health ping)
server -> phone   len=66   (pong)
server -> phone   len=85
server -> phone   len=31
phone  -> server  len=0    (ACK -- the phone received all of it)
```

So the path itself was fine. Small frames flowed both ways indefinitely on a
socket both ends agreed about.

**4. 34 distinct phone source ports appeared in a 120-second capture**, for what
should have been about three connections.

## Wrong turns worth recording

Three conclusions I reached and had to retract. Each cost real time.

- **"The network kills long-lived connections."** False. Short frames flow
  indefinitely; the healthy port-55206 cycle above ran for the whole capture.
- **"Frames >= 4KB are dropped."** False. The `ws_size_test` ladder appeared to
  stop at 3KB, but it was measuring a socket that had already stalled for
  another reason. A 7915-char `todo_result` was later observed arriving reliably
  215ms after connect, repeatedly.
- **"It works from the desktop, so it is the phone's network."** This control was
  worthless: the desktop reaches the orchestrator over the VPN and its public IP
  *is* `65.108.225.44`, the server itself. That traffic never left the machine.
  Only the phone with VPN off exercises the real path.

## The fix

`src/index.js` now runs the standard `ws` liveness sweep: ping every client
every 30s, terminate any client that did not answer the previous round. Sockets
carrying real traffic answer automatically, so only genuinely dead ones are
killed. Liveness is armed inside each `handleUpgrade` callback, because with
`noServer: true` the server never emits a `connection` event.

Tested by `tests/ws-liveness-reaper.test.js`.

## Related fixes made while tracking this down

Each was a real bug with its own symptom:

- **Two simultaneous WebSockets on the phone.** `connect()` overwrote the
  transport field without closing the old socket, so replies arrived on a socket
  the app was no longer reading. Presented exactly as a one-way stall.
- **OkHttp WebSocket pings were disabled** (`pingInterval(0)`), on the grounds
  that the HTTP health check covered them. It does not -- that check runs over a
  separate connection.
- **Lost frames were not replayed.** The pending queue was discarded on
  reconnect; terminal frames (tool completions, settled turn text, permission
  prompts, errors) are now queued even on an apparently successful send and
  replayed, so a completion written into a half-open socket is not lost.
- **The health pong went to the wrong socket** after a reconnect, because it was
  addressed to whatever was registered for the device id rather than the socket
  the ping arrived on.

## How to reproduce the measurement

```bash
# server: capture the phone's real flow
ssh hetzner-root "timeout 120 tcpdump -i enp41s0 -n 'host <PHONE_PUBLIC_IP> and port 8443' -w /tmp/phone.pcap"

# server: connection count from that phone, watch it grow
ssh hetzner-root "ss -tn state all | grep '<PHONE_PUBLIC_IP>' | awk '{print \$1}' | sort | uniq -c"

# phone: its own view -- FIN-WAIT-1 with queued bytes is the signature
adb shell ss -tn | grep 65.108
```

Find the phone's public IP by capturing inbound SYNs rather than assuming:

```bash
ssh hetzner-root "timeout 45 tcpdump -i enp41s0 -n 'tcp dst port 8443' -c 40 | awk '{print \$3}' | cut -d. -f1-4 | sort | uniq -c"
```

## Second finding: the phone's packets stop leaving the phone

After the reaper shipped, reconnects fell (2 -> 1 per two minutes) and
half-open stalls went to zero, but the connection still did not survive. A
second capture identifies why, and it is **not** in our code.

Connection on phone port 33582 ran a clean 5-second cycle for 20 seconds --
every frame acknowledged, healthy throughout:

```
P->S len=49    (health ping)
S->P len=66    (pong)
S->P len=85
S->P len=31
P->S len=0     (ACK)
```

Then, at `1788358014.214883`, the phone sent one more ping, the server
answered, and the phone **transmitted nothing ever again**:

```
1788358014.214883 P->S len=49    <- last packet the phone ever sends
1788358014.215766 S->P len=66
1788358014.215784 S->P len=85
1788358014.215824 S->P len=31
1788358014.302386 S->P len=31
1788358014.550396 S->P len=182   <- server retransmits, backing off
1788358015.062404 S->P len=182
1788358016.054396 S->P len=182
1788358018.038393 S->P len=182
1788358022.194402 S->P len=182
1788358030.130413 S->P len=182
```

No ACK, no FIN, no RST -- the phone simply goes silent. The connection had
lasted 35.9 seconds and carried 53 packets.

**This is a path failure, not an application one.** The app cannot fail to send
a TCP ACK; the kernel does that. Packets leaving the phone stop arriving at the
server mid-connection, while the reverse direction still works (the server's
retransmissions are being transmitted normally).

### One measurement that looked like a smoking gun and was not

The phone advertised `win 16` in those final packets, which reads as a
receive-window collapse. It is not: the SYN negotiated `wscale 9`, so the real
window is `16 << 9` = **8192 bytes** -- ample for the 182-byte frame. Always
resolve the window scale before concluding a zero-window stall.

### What this means

The remaining work is not in the orchestrator or the phone app. The candidates
are the phone's WiFi/router path or carrier NAT dropping the flow. Application
fixes can only make the failure survivable -- which the pending-queue replay and
the liveness reaper now do -- not prevent it.
