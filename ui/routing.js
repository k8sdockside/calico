// Routing & BGP: the nodes on a circle, the node-to-node mesh as chords
// between them, route reflectors marked, and the external BGP peers outside
// the circle wired to the nodes that peer with them -- coloured by what
// calico-node reports for each session where a CalicoNodeStatus asks it to.
// With BGP off, the chords are the VXLAN overlay instead. A node or a peer
// opens in the inspector.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var C = window.Calico;
    var K = window.CalicoKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;
    var MAX_CHORDS_NODES = 40;
    var MAX_LABELS = 36;
    var MAX_PEERS = 12;

    var state = { ctx: null, model: null, sig: '', error: '', selected: '', width: 0, summary: null };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function fail(err) {
        state.error = (err && err.message) || String(err);
        drawError();
    }

    function drawError() {
        $('error').textContent = state.error;
        $('error').hidden = !state.error;
    }

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    var plural = C.plural;
    var svg = K.svg;

    function writeHash() {
        K.writeHash({ sel: state.selected, width: state.width });
    }

    function select(key) {
        state.selected = state.selected === key ? '' : key;
        writeHash();
        render();
        if (state.selected && window.matchMedia('(max-width: 1020px)').matches) $('inspector').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    // ----- reading ---------------------------------------------------------------

    function mode(model) {
        if (model.bgp.enabled === false) return 'tunnel';
        if (model.bgp.enabled === null && !model.bgp.config && !model.peers.length) {
            // Nothing says BGP is on; a VXLAN-only cluster reads like this.
            var vx = model.pools.some(function (p) {
                return p.encap.id === 'vxlan' && !p.encap.cross;
            });
            return vx ? 'tunnel' : 'unknown';
        }
        return 'bgp';
    }

    function nodeIP(n) {
        return C.stripMask(n.ipv4 || n.ipv6 || n.internalIPs[0] || '');
    }

    // The state of the session between two nodes, from either end's report.
    function meshState(model, a, b) {
        var s = C.sessionBetween(model, a, nodeIP(b)) || C.sessionBetween(model, b, nodeIP(a));
        if (!s) return 'unknown';
        return s.up ? 'up' : 'down';
    }

    function peerState(model, peer, node) {
        var s = C.sessionBetween(model, node, peer.ip);
        if (!s) return 'unknown';
        return s.up ? 'up' : 'down';
    }

    function peerTone(model, peer) {
        if (!peer.sessions.length) return 'unknown';
        return peer.sessions.some(function (s) {
            return !s.up;
        })
            ? 'down'
            : 'up';
    }

    function nodeTone(model, n) {
        if (!model.componentsKnown) return 'unknown';
        if (!n.calico) return 'warn';
        if (!n.calicoReady) return 'error';
        if (n.bird && n.bird !== 'Ready') return 'error';
        var down = model.sessions.some(function (s) {
            return s.node === n && !s.up;
        });
        return down ? 'warn' : '';
    }

    // ----- the sentence --------------------------------------------------------------

    function drawLede(model) {
        var p = $('lede');
        p.textContent = '';
        p.hidden = false;
        var m = mode(model);
        var b = function (t) {
            return el('strong', '', t);
        };
        if (m === 'tunnel') {
            var pools = model.pools
                .filter(function (x) {
                    return x.encap.id !== 'none';
                })
                .map(function (x) {
                    return x.encap.label;
                });
            add(p, b('BGP is off.'), ' The ' + plural(model.nodes.length, 'node') + ' reach each other’s pods through ', b(pools.length ? pools.filter(unique).join(' and ') + ' tunnels' : 'the underlay'), ', and Felix programs the routes from what IPAM knows — nothing is announced to the network outside.');
            return;
        }
        if (m === 'unknown') {
            add(p, 'Nothing here says whether Calico runs BGP: there is no operator Installation, no BGPConfiguration and no BGP peer, and calico-node does not say which backend it uses.');
            return;
        }
        var bgp = model.bgp;
        add(p, b('BGP is on'), ' in AS ', b(String(bgp.asn)), bgp.asnSet ? '' : ' (the default)', '. ');
        if (bgp.mesh) add(p, 'Every node peers with every other in a ', b('full mesh'), ' of ' + plural((model.nodes.length * (model.nodes.length - 1)) / 2, 'session') + '. ');
        else if (model.routeReflectors.length) add(p, 'The mesh is off; ', b(plural(model.routeReflectors.length, 'route reflector')), ' carry the routes. ');
        else add(p, 'The mesh is off. ');
        if (model.peers.length) add(p, b(plural(model.peers.length, 'external peer')), ' receive the pod and service routes. ');
        if (model.sessionsKnown) {
            var down = model.sessions.filter(function (s) {
                return !s.up;
            }).length;
            var s = b(down ? down + ' of ' + model.sessions.length + ' reported sessions are down' : 'all ' + model.sessions.length + ' reported sessions are established');
            if (down) s.className = 'bad-text';
            add(p, s, '.');
        } else {
            add(p, 'Session state is not reported — see the note on the right.');
        }
    }

    function unique(x, i, all) {
        return all.indexOf(x) === i;
    }

    // ----- the diagram ----------------------------------------------------------------

    function drawDiagram(model) {
        var box = $('diagram');
        box.textContent = '';
        var m = mode(model);
        var head = el('div', 'radial-head');
        add(head, K.icon(m === 'tunnel' ? 'tunnel' : 'mesh'), el('h2', '', m === 'tunnel' ? 'Overlay between nodes' : 'BGP topology'), el('span', 'card-sub', m === 'tunnel' ? 'Hover a node to follow its tunnels; click it for details.' : 'Hover a node or peer to follow its sessions; click it for details.'));
        box.appendChild(head);

        var nodes = model.nodes;
        var peers = model.peers.filter(function (p) {
            return p.ip;
        });
        var shownPeers = peers.slice(0, MAX_PEERS);
        // Laid out in the card's own pixels, so labels keep their size on a
        // narrow pane; redrawn when the card changes width.
        var avail = Math.round(box.clientWidth - 28) || 900;
        var W = Math.max(560, avail);
        var peerRoom = shownPeers.length ? 226 : 0;
        var H = Math.max(Math.min(640, Math.round(W * 0.62)), 460, 80 + shownPeers.length * 64);
        var cx = shownPeers.length ? Math.round((W - peerRoom) / 2) : W / 2;
        var cy = H / 2;
        var n = nodes.length;
        var R = n <= 1 ? 0 : Math.max(90, Math.min(225, Math.max(165, n * 14), cx - 118, H / 2 - 64));
        state.laidOut = W;
        var nodeR = n > 60 ? 5 : n > 30 ? 9 : n > 12 ? 14 : 19;
        var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'radial', role: 'img' });
        root.setAttribute('aria-label', 'Nodes and their BGP sessions');
        var edges = svg('g', {});
        var things = svg('g', {});
        root.appendChild(svg('circle', { cx: cx, cy: cy, r: R, class: 'r-orbit' }));
        root.appendChild(edges);
        root.appendChild(things);

        var pos = {};
        nodes.forEach(function (node, i) {
            var a = -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2;
            pos[node.name] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), a: a };
        });

        // Chords: the mesh, or the tunnels.
        var chords = (m === 'tunnel' || model.bgp.mesh) && n > 1 && n <= MAX_CHORDS_NODES;
        if (chords) {
            for (var i = 0; i < n; i++) {
                for (var j = i + 1; j < n; j++) {
                    var A = pos[nodes[i].name];
                    var B = pos[nodes[j].name];
                    var mx = (A.x + B.x) / 2;
                    var my = (A.y + B.y) / 2;
                    var qx = cx + (mx - cx) * 0.3;
                    var qy = cy + (my - cy) * 0.3;
                    var cls = m === 'tunnel' ? 'tunnel' : meshState(model, nodes[i], nodes[j]);
                    var path = svg('path', { d: 'M' + A.x.toFixed(1) + ' ' + A.y.toFixed(1) + ' Q' + qx.toFixed(1) + ' ' + qy.toFixed(1) + ' ' + B.x.toFixed(1) + ' ' + B.y.toFixed(1), class: 'r-chord ' + (cls === 'unknown' ? '' : cls) });
                    path.dataset.a = 'node:' + nodes[i].name;
                    path.dataset.b = 'node:' + nodes[j].name;
                    edges.appendChild(path);
                }
            }
        }

        // Route reflector sessions: peers chosen by selector.
        model.peers.forEach(function (p) {
            if (!p.peerSel) return;
            p.from.forEach(function (a) {
                p.to.forEach(function (b) {
                    if (a === b || !pos[a.name] || !pos[b.name]) return;
                    var A = pos[a.name];
                    var B = pos[b.name];
                    var st = meshState(model, a, b);
                    var line = svg('path', { d: 'M' + A.x.toFixed(1) + ' ' + A.y.toFixed(1) + ' L' + B.x.toFixed(1) + ' ' + B.y.toFixed(1), class: 'r-edge rr ' + (st === 'down' ? 'down' : '') });
                    line.dataset.a = 'node:' + a.name;
                    line.dataset.b = 'node:' + b.name;
                    line.dataset.c = 'peer:' + p.name;
                    edges.appendChild(line);
                });
            });
        });

        // External peers in a column on the right.
        var peerPos = {};
        shownPeers.forEach(function (p, k) {
            var y = H / 2 + (k - (shownPeers.length - 1) / 2) * 64;
            peerPos[p.name] = { x: W - 204, y: y };
        });
        shownPeers.forEach(function (p) {
            var P = peerPos[p.name];
            p.from.forEach(function (node) {
                var A = pos[node.name];
                if (!A) return;
                var st = peerState(model, p, node);
                var sx = A.x + Math.cos(A.a) * nodeR;
                var sy = A.y + Math.sin(A.a) * nodeR;
                var c1x = sx + (P.x - sx) * 0.55;
                var d = 'M' + sx.toFixed(1) + ' ' + sy.toFixed(1) + ' C' + c1x.toFixed(1) + ' ' + sy.toFixed(1) + ' ' + (P.x - 60).toFixed(1) + ' ' + P.y.toFixed(1) + ' ' + P.x.toFixed(1) + ' ' + P.y.toFixed(1);
                var e = svg('path', { d: d, class: 'r-edge ' + (st === 'unknown' ? '' : st) });
                e.dataset.a = 'node:' + node.name;
                e.dataset.b = 'peer:' + p.name;
                var t = svg('title', {});
                t.textContent = node.name + ' → ' + p.name + ': ' + (st === 'unknown' ? 'state not reported' : st === 'up' ? 'Established' : 'not established');
                e.appendChild(t);
                edges.appendChild(e);
            });
        });

        // The nodes.
        var labels = n <= MAX_LABELS;
        nodes.forEach(function (node) {
            var P = pos[node.name];
            var tone = nodeTone(model, node);
            var g = svg('g', { class: 'r-node ' + tone + (state.selected === 'node:' + node.name ? ' sel' : ''), transform: 'translate(' + P.x.toFixed(1) + ' ' + P.y.toFixed(1) + ')', tabindex: '0', role: 'button' });
            g.dataset.key = 'node:' + node.name;
            g.appendChild(svg('circle', { r: nodeR + 7, class: 'halo' }));
            if (node.rr) g.appendChild(svg('circle', { r: nodeR + 5, class: 'rr-ring' }));
            g.appendChild(svg('circle', { r: nodeR, class: 'body' }));
            if (nodeR >= 14) {
                var s = nodeR / 22;
                var glyph = svg('g', { transform: 'scale(' + s.toFixed(3) + ') translate(-12 -12)' });
                ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M8 7h.01', 'M8 17h.01'].forEach(function (dd) {
                    glyph.appendChild(svg('path', { d: dd, class: 'glyph' }));
                });
                g.appendChild(glyph);
            }
            if (node.rr) {
                var badge = svg('g', { class: 'r-badge', transform: 'translate(' + (nodeR - 2) + ' ' + (-nodeR - 2) + ')' });
                badge.appendChild(svg('rect', { x: -10, y: -7, width: 20, height: 13, rx: 6 }));
                var bt = svg('text', { y: 3 });
                bt.textContent = 'RR';
                badge.appendChild(bt);
                g.appendChild(badge);
            }
            var title = svg('title', {});
            title.textContent = node.name + ' · ' + (nodeIP(node) || 'no address') + (node.rr ? ' · route reflector ' + node.rr : '') + (tone === 'error' ? ' · calico-node not ready' : '');
            g.appendChild(title);
            if (labels || state.selected === 'node:' + node.name) {
                var lx = Math.cos(P.a) * (nodeR + 14);
                var ly = Math.sin(P.a) * (nodeR + 14);
                var anchor = Math.abs(Math.cos(P.a)) < 0.3 ? 'middle' : Math.cos(P.a) > 0 ? 'start' : 'end';
                var dy = Math.abs(Math.cos(P.a)) < 0.3 ? (Math.sin(P.a) > 0 ? 12 : -8) : 4;
                var label = svg('text', { x: lx.toFixed(1), y: (ly + dy).toFixed(1), 'text-anchor': anchor, class: 'r-label' });
                label.textContent = node.name;
                g.appendChild(label);
                var sub = svg('text', { x: lx.toFixed(1), y: (ly + dy + 14).toFixed(1), 'text-anchor': anchor, class: 'r-sub' });
                sub.textContent = nodeIP(node) + (node.asn ? ' · AS ' + node.asn : '');
                g.appendChild(sub);
            }
            things.appendChild(g);
        });

        // The peers.
        shownPeers.forEach(function (p) {
            var P = peerPos[p.name];
            var tone = peerTone(model, p);
            var g = svg('g', { class: 'r-peer ' + (tone === 'unknown' ? '' : tone) + (state.selected === 'peer:' + p.name ? ' sel' : ''), transform: 'translate(' + P.x + ' ' + P.y + ')', tabindex: '0', role: 'button' });
            g.dataset.key = 'peer:' + p.name;
            g.appendChild(svg('rect', { x: -6, y: -29, width: 212, height: 58, rx: 16, class: 'halo' }));
            g.appendChild(svg('rect', { x: 0, y: -23, width: 200, height: 46, rx: 12, class: 'body' }));
            var glyph = svg('g', { transform: 'translate(10 -10) scale(0.85)' });
            ['M7 18.5h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.1 11.8 3.4 3.4 0 0 0 7 18.5z'].forEach(function (dd) {
                glyph.appendChild(svg('path', { d: dd, class: 'glyph' }));
            });
            g.appendChild(glyph);
            var name = svg('text', { x: 38, y: -3, class: 'r-label' });
            name.textContent = p.name.length > 20 ? p.name.slice(0, 19) + '…' : p.name;
            g.appendChild(name);
            var sub = svg('text', { x: 38, y: 13, class: 'r-sub' });
            sub.textContent = p.ip + (p.asn ? ' · AS ' + p.asn : '');
            g.appendChild(sub);
            var t = svg('title', {});
            t.textContent = p.name + ' — ' + p.ip + ' AS ' + p.asn + ' — peers with ' + plural(p.from.length, 'node');
            g.appendChild(t);
            things.appendChild(g);
        });

        // The centre.
        var big = svg('text', { x: cx, y: cy + (n <= 1 ? -34 : -2), class: 'r-centre-big' });
        big.textContent = String(n);
        root.appendChild(big);
        var small = svg('text', { x: cx, y: cy + (n <= 1 ? -18 : 16), class: 'r-centre' });
        small.textContent = m === 'tunnel' ? (n === 1 ? 'node' : 'nodes') + ' · overlay' : (n === 1 ? 'node' : 'nodes') + (model.bgp.mesh ? ' · full mesh' : model.routeReflectors.length ? ' · reflected' : '');
        root.appendChild(small);
        if (!chords && n > MAX_CHORDS_NODES && (m === 'tunnel' || model.bgp.mesh)) {
            var note = svg('text', { x: cx, y: cy + 32, class: 'r-centre' });
            note.textContent = 'too many to draw every session';
            root.appendChild(note);
        }
        box.appendChild(root);

        // The key.
        var key = el('div', 'radial-key');
        if (m === 'tunnel') {
            add(key, add(el('span'), el('i', 'tunnel'), 'tunnel between nodes'));
        } else {
            if (model.bgp.mesh) add(key, add(el('span'), el('i', 'mesh'), 'mesh session'));
            add(key, add(el('span'), el('i', 'up'), 'established'), add(el('span'), el('i', 'down'), 'down'), add(el('span'), el('i', 'unknown'), 'state not reported'));
            if (model.routeReflectors.length) add(key, add(el('span'), el('i', 'rr'), 'route reflector'));
        }
        if (peers.length > shownPeers.length) key.appendChild(el('span', 'faint', '+' + (peers.length - shownPeers.length) + ' more peers in the list'));
        box.appendChild(key);

        if (m === 'bgp' && !model.sessionsKnown) box.appendChild(statusHint(model, nodes[0] ? nodes[0].name : 'my-node'));
        if (m === 'tunnel') {
            var hint = el('div', 'hint');
            add(hint, K.icon('info'), el('div', '', 'With BGP off, nothing outside the cluster learns the pod routes; traffic leaving the cluster is masqueraded where the pool has NAT outgoing on. Turn BGP on in the operator’s Installation (calicoNetwork.bgp: Enabled) to peer with your routers.'));
            box.appendChild(hint);
        }
    }

    // A note on how to see live BGP state: calico-node reports it when a
    // CalicoNodeStatus asks. The page does not create one itself.
    function statusHint(model, nodeName) {
        var hint = el('div', 'hint');
        var body = el('div');
        add(body, el('strong', '', 'Session state is not reported. '), 'calico-node writes what BIRD knows about each BGP session into a CalicoNodeStatus, but only for nodes that have one. Create one per node you care about, for example:');
        var pre = el('pre', 'snippet');
        pre.textContent = ['apiVersion: projectcalico.org/v3', 'kind: CalicoNodeStatus', 'metadata:', '  name: ' + nodeName, 'spec:', '  node: ' + nodeName, '  classes: [Agent, BGP]', '  updatePeriodSeconds: 30'].join('\n');
        body.appendChild(pre);
        var more = K.button('About CalicoNodeStatus', 'ghost small', 'open', function () {
            sdk.openUrl('https://docs.tigera.io/calico/latest/reference/resources/caliconodestatus').catch(fail);
        });
        body.appendChild(more);
        add(hint, K.icon('info'), body);
        return hint;
    }

    // ----- the inspector ---------------------------------------------------------------

    function sec(title, body, extra) {
        var s = el('section', 'side-sec');
        var h = el('h3', 'mini-title', title);
        if (extra) h.appendChild(extra);
        s.appendChild(h);
        add(s, body);
        return s;
    }

    function fact(label, value, off) {
        var f = el('div', 'bfact');
        add(f, el('div', 'bfact-label', label), el('div', 'bfact-value' + (off ? ' off' : ''), value));
        return f;
    }

    function peerRow(model, p) {
        var row = K.button('', 'peer-row', null, function () {
            select('peer:' + p.name);
        });
        var icon = el('span', 'peer-icon');
        icon.appendChild(K.icon(p.peerSel ? 'star' : 'cloud'));
        var main = el('span', 'peer-main');
        var scope = p.scope === 'global' ? 'every node' : p.scope === 'node' ? 'node ' + p.node : p.nodeSelector + ' (' + p.from.length + ')';
        add(main, el('span', 'peer-name', p.name), el('span', 'peer-sub', (p.peerSel ? 'nodes matching ' + p.peerSelector : p.peerIP + ' · AS ' + (p.asn || '?')) + ' · from ' + scope));
        var up = p.sessions.filter(function (s) {
            return s.up;
        }).length;
        var status = p.sessions.length ? K.chip(up + ' / ' + p.sessions.length + ' up', up === p.sessions.length ? 'ok' : 'error') : K.chip('no state', 'muted');
        add(row, icon, main, status);
        return row;
    }

    function drawSummary(box, model) {
        var head = el('div', 'insp-head');
        head.appendChild(el('h2', '', 'BGP configuration'));
        if (model.bgp.config) {
            head.appendChild(
                K.iconButton('open', 'Open the BGPConfiguration', function () {
                    open({ kind: C.KINDS.bgpConfig, namespace: '', name: 'default' });
                }),
            );
        }
        box.appendChild(head);
        var m = mode(model);
        var grid = el('div', 'bgp-facts');
        add(
            grid,
            fact('BGP', m === 'tunnel' ? 'Off' : m === 'unknown' ? 'Unknown' : 'On', m !== 'bgp'),
            fact('Node mesh', m !== 'bgp' ? '—' : model.bgp.mesh ? 'On' : 'Off', m !== 'bgp' || !model.bgp.mesh),
            fact('AS number', m !== 'bgp' ? '—' : String(model.bgp.asn) + (model.bgp.asnSet ? '' : ' (default)'), m !== 'bgp'),
            fact('Listen port', m !== 'bgp' ? '—' : String(model.bgp.listenPort), m !== 'bgp'),
            fact('Route reflectors', String(model.routeReflectors.length), !model.routeReflectors.length),
            fact('External peers', String(model.peers.length), !model.peers.length),
        );
        box.appendChild(grid);
        if (m === 'bgp' && !model.bgp.config && model.bgp.served) box.appendChild(el('p', 'insp-note', 'No BGPConfiguration named default: Calico uses its defaults (mesh on, AS 64512).'));
        if (m === 'tunnel') box.appendChild(el('p', 'insp-note', 'BGP is off' + (model.installation ? ' in the operator’s Installation' : model.backend ? ' (calico-node runs with the ' + model.backend + ' backend)' : '') + ', so there are no sessions and nothing is advertised.'));

        var adv = el('div', 'adv');
        [
            ['Service cluster IPs', model.bgp.clusterIPs],
            ['External IPs', model.bgp.externalIPs],
            ['LoadBalancer IPs', model.bgp.lbIPs],
            [
                'Prefixes',
                model.bgp.prefixAdvertisements.map(function (x) {
                    return x.cidr;
                }),
            ],
        ].forEach(function (row) {
            var r = el('div', 'adv-row');
            add(r, el('span', 'faint', row[0]), row[1].length ? el('code', '', row[1].join(', ')) : el('span', 'faint', 'not advertised'));
            adv.appendChild(r);
        });
        if (m !== 'tunnel') box.appendChild(sec('Advertised to peers', adv));

        var list = el('div');
        if (!model.bgp.peersServed) list.appendChild(el('p', 'quiet', 'This cluster does not serve BGPPeers.'));
        else if (!model.peers.length) list.appendChild(el('p', 'quiet', m === 'bgp' ? 'No BGP peer. Only the nodes exchange routes' + (model.bgp.mesh ? ', over the mesh.' : ' — and with the mesh off, nobody does.') : 'No BGP peer.'));
        model.peers.forEach(function (p) {
            list.appendChild(peerRow(model, p));
        });
        box.appendChild(sec('Peers', list, el('span', 'count muted', String(model.peers.length))));

        if (model.bgp.filters.length) {
            var fl = el('div');
            model.bgp.filters.forEach(function (f) {
                var line = el('div', 'adv-row');
                var c = f.counts;
                add(
                    line,
                    K.link(f.name, function () {
                        open({ kind: C.KINDS.bgpFilters, namespace: '', name: f.name });
                    }),
                    el('span', 'faint', [c.importV4 ? c.importV4 + ' import v4' : '', c.exportV4 ? c.exportV4 + ' export v4' : '', c.importV6 ? c.importV6 + ' import v6' : '', c.exportV6 ? c.exportV6 + ' export v6' : ''].filter(Boolean).join(' · ') || 'no rules'),
                );
                fl.appendChild(line);
            });
            box.appendChild(sec('Filters', fl));
        }

        var nodes = el('div', 'node-row');
        model.nodes.slice(0, 60).forEach(function (n) {
            var row = K.button('', 'node-line', null, function () {
                select('node:' + n.name);
            });
            var tone = nodeTone(model, n);
            var sw = el('i');
            sw.style.setProperty('--c', tone === 'error' ? 'var(--k-error)' : tone === 'warn' ? 'var(--k-warn)' : tone === 'unknown' ? 'var(--k-faint)' : 'var(--k-ok)');
            var mine = model.sessions.filter(function (s) {
                return s.node === n;
            });
            var up = mine.filter(function (s) {
                return s.up;
            }).length;
            add(row, sw, el('span', 'node-line-name', n.name + (n.rr ? '  ★' : '')), el('span', 'node-line-meta', nodeIP(n) + (mine.length ? ' · ' + up + '/' + mine.length + ' up' : '')));
            nodes.appendChild(row);
        });
        box.appendChild(sec('Nodes', nodes, el('span', 'count muted', String(model.nodes.length))));
    }

    function drawNode(box, model, n) {
        var head = el('div', 'insp-head');
        add(
            head,
            el('h2', '', 'Node'),
            K.iconButton('close', 'Back to the BGP configuration', function () {
                select('');
            }),
        );
        box.appendChild(head);
        box.appendChild(el('h2', 'd-title', n.name));
        var sub = el('div', 'd-sub');
        sub.appendChild(n.calico ? K.chip(n.calicoReady ? 'calico-node ready' : 'calico-node not ready', n.calicoReady ? 'ok' : 'error', n.calicoReady ? 'check' : 'alert') : K.chip('no calico-node', model.componentsKnown ? 'warn' : 'muted'));
        sub.appendChild(K.chip(n.ready ? 'node Ready' : 'node not Ready', n.ready ? 'outline' : 'error'));
        if (n.rr) sub.appendChild(K.chip('route reflector', 'warn', 'star'));
        box.appendChild(sub);

        var dl = el('dl', 'facts');
        dl.style.marginTop = '12px';
        function row(label, value) {
            if (!value) return;
            add(dl, el('dt', '', label), add(el('dd'), typeof value === 'string' ? el('code', '', value) : value));
        }
        row('IPv4', n.ipv4);
        row('IPv6', n.ipv6);
        row('AS number', n.asn ? n.asn : mode(model) === 'bgp' ? String(model.bgp.asn) + ' (cluster default)' : '');
        row('VXLAN tunnel', n.vxlan || n.vxlan6);
        row('IPIP tunnel', n.ipip);
        row('WireGuard', n.wg ? n.wg : n.wgKey ? 'key only' : '');
        if (n.wgKey) row('Public key', n.wgKey.length > 22 ? n.wgKey.slice(0, 20) + '…' : n.wgKey);
        row('RR cluster ID', n.rr);
        if (n.calico) {
            row(
                'calico-node',
                add(
                    el('span'),
                    K.link(n.calico.metadata.name, function () {
                        open(C.podRef(n.calico));
                    }),
                    el('span', 'faint', ' · ' + n.calicoPhase + (n.calicoRestarts ? ' · ' + n.calicoRestarts + ' restarts' : '')),
                ),
            );
        }
        row('Workloads', add(el('span'), String(n.pods)));
        box.appendChild(dl);

        var tools = el('div', 'd-tools');
        tools.style.margin = '12px 0 0';
        tools.style.justifyContent = 'flex-start';
        tools.style.flexWrap = 'wrap';
        add(
            tools,
            K.button('Open node', 'ghost small', 'open', function () {
                open({ kind: C.KINDS.nodes, namespace: '', name: n.name });
            }),
            n.calico
                ? K.button('calico-node logs', 'ghost small', 'log', function () {
                      sdk.logs(C.podRef(n.calico)).catch(fail);
                  })
                : null,
            n.status
                ? K.button('Node status', 'ghost small', 'activity', function () {
                      open({ kind: C.KINDS.nodeStatus, namespace: '', name: n.status.metadata.name });
                  })
                : null,
        );
        box.appendChild(tools);

        // Sessions.
        var sessions = model.sessions.filter(function (s) {
            return s.node === n;
        });
        var sb = el('div', 'sess-list');
        if (n.peers === null) {
            if (mode(model) === 'bgp') sb.appendChild(statusHint(model, n.name));
            else sb.appendChild(el('p', 'quiet', 'BGP is off, so this node has no sessions.'));
        } else if (!sessions.length) {
            sb.appendChild(el('p', 'quiet', 'calico-node reports no BGP session.'));
        }
        sessions.forEach(function (s) {
            var line = el('div', 'sess');
            var who = s.peer ? s.peer.name : s.peerNode ? s.peerNode.name : s.ip;
            var name = el('span', 'node-line-name');
            if (s.peerNode) {
                name.appendChild(
                    K.link(who, function () {
                        select('node:' + s.peerNode.name);
                    }),
                );
            } else if (s.peer) {
                name.appendChild(
                    K.link(who, function () {
                        select('peer:' + s.peer.name);
                    }),
                );
            } else name.textContent = who;
            name.appendChild(el('span', 'faint', ' · ' + ({ NodeMesh: 'mesh', NodePeer: 'node peer', GlobalPeer: 'global peer' }[s.type] || s.type)));
            add(line, K.sdot(s.up ? 'ok' : 'error'), name, el('span', 'sess-state ' + (s.up ? 'up' : 'down'), s.state + (s.since ? ' · ' + K.age(s.since) : '')));
            line.title = s.ip + ' — ' + s.state + (s.since ? ' since ' + s.since : '');
            sb.appendChild(line);
        });
        if (n.bird && n.bird !== 'Ready') sb.insertBefore(el('p', 'bad-text', 'BIRD is ' + n.bird + ' on this node.'), sb.firstChild);
        box.appendChild(sec('BGP sessions', sb, sessions.length ? el('span', 'count muted', String(sessions.length)) : null));

        var mine = model.peers.filter(function (p) {
            return p.from.indexOf(n) >= 0;
        });
        if (mine.length) {
            var pl = el('div');
            mine.forEach(function (p) {
                pl.appendChild(peerRow(model, p));
            });
            box.appendChild(sec('Configured peers', pl));
        }

        if (n.blocks.length) {
            var map = el('div', 'mini-map');
            n.blocks.slice(0, 40).forEach(function (b) {
                var t = K.blockTile(b, model, {});
                t.addEventListener('click', function () {
                    open({ kind: C.KINDS.blocks, namespace: '', name: b.name });
                });
                t.title = b.cidr + ' · ' + b.used + ' of ' + b.size + ' in use';
                map.appendChild(t);
            });
            box.appendChild(sec('Affine blocks', map, el('span', 'count muted', String(n.blocks.length))));
        }
    }

    function drawPeer(box, model, p) {
        var head = el('div', 'insp-head');
        add(
            head,
            el('h2', '', 'BGP peer'),
            K.iconButton('close', 'Back to the BGP configuration', function () {
                select('');
            }),
        );
        box.appendChild(head);
        box.appendChild(el('h2', 'd-title', p.name));
        var sub = el('div', 'd-sub');
        add(sub, el('code', '', p.peerIP || 'peers by selector'), p.asn ? el('span', '', '· AS ' + p.asn) : null);
        box.appendChild(sub);

        var dl = el('dl', 'facts');
        dl.style.marginTop = '12px';
        function row(label, value) {
            if (!value) return;
            add(dl, el('dt', '', label), add(el('dd'), typeof value === 'string' ? el('span', '', value) : value));
        }
        row('Applies to', p.scope === 'global' ? 'every node' : p.scope === 'node' ? 'node ' + p.node : el('code', '', p.nodeSelector));
        if (p.nodeSel && !p.nodeSel.ok) row('Selector error', el('span', 'bad-text', p.nodeSel.error));
        row('Peers with', p.peerSelector ? el('code', '', p.peerSelector) : '');
        row('Local AS', p.obj.spec && p.obj.spec.localASNumber ? String(p.obj.spec.localASNumber) : '');
        row('Next hop', p.keepNextHop ? 'kept' : p.obj.spec && p.obj.spec.nextHopMode ? p.obj.spec.nextHopMode : '');
        row('Password', p.password ? 'from a secret' : '');
        row('Reachable by', p.reachableBy);
        if (p.filters.length) {
            var fl = el('span');
            p.filters.forEach(function (f, i) {
                if (i) fl.appendChild(document.createTextNode(', '));
                fl.appendChild(
                    K.link(f, function () {
                        open({ kind: C.KINDS.bgpFilters, namespace: '', name: f });
                    }),
                );
            });
            row('Filters', fl);
        }
        box.appendChild(dl);

        var tools = el('div', 'd-tools');
        tools.style.margin = '12px 0 0';
        tools.style.justifyContent = 'flex-start';
        var ref = { kind: C.KINDS.bgpPeers, namespace: '', name: p.name };
        add(
            tools,
            K.button('Open peer', 'ghost small', 'open', function () {
                open(ref);
            }),
            K.button('YAML', 'ghost small', 'edit', function () {
                sdk.edit(ref).catch(fail);
            }),
        );
        box.appendChild(tools);

        var list = el('div', 'sess-list');
        (p.peerSel ? p.to : p.from).forEach(function (n) {
            var st = p.peerSel ? 'unknown' : peerState(model, p, n);
            var s = C.sessionBetween(model, n, p.ip);
            var line = el('div', 'sess');
            var name = el('span', 'node-line-name');
            name.appendChild(
                K.link(n.name, function () {
                    select('node:' + n.name);
                }),
            );
            add(line, K.sdot(st === 'up' ? 'ok' : st === 'down' ? 'error' : 'muted'), name, el('span', 'sess-state ' + (st === 'unknown' ? 'faint' : st), s ? s.state + (s.since ? ' · ' + K.age(s.since) : '') : 'not reported'));
            list.appendChild(line);
        });
        if (!list.childNodes.length) list.appendChild(el('p', 'quiet', 'No node matches.'));
        box.appendChild(sec(p.peerSel ? 'Reflector nodes' : 'Nodes peering with it', list));
    }

    function drawInspector(model) {
        var box = $('inspector');
        var scroll = box.scrollTop;
        box.textContent = '';
        var sel = state.selected;
        var cut = sel.indexOf(':');
        var kind = sel.slice(0, cut);
        var name = sel.slice(cut + 1);
        var node = kind === 'node' ? model.nodeByName[name] : null;
        var peer =
            kind === 'peer'
                ? model.peers.filter(function (p) {
                      return p.name === name;
                  })[0]
                : null;
        box.classList.toggle('active', !!(node || peer));
        if (node) drawNode(box, model, node);
        else if (peer) drawPeer(box, model, peer);
        else drawSummary(box, model);
        box.scrollTop = node || peer ? scroll : 0;
    }

    // ----- putting it together -------------------------------------------------------

    function render() {
        var model = state.model;
        if (!model) return;
        drawError();
        var where = state.ctx.contextName;
        if (model.version) where += ' · Calico ' + model.version;
        $('where').textContent = where;
        if (!model.installed) {
            var box = $('empty');
            box.textContent = '';
            box.hidden = false;
            box.appendChild(K.absent(sdk, state.ctx, model, state.summary, fail));
            $('layout').hidden = true;
            $('lede').hidden = true;
            return;
        }
        $('empty').hidden = true;
        $('layout').hidden = false;
        drawLede(model);
        drawDiagram(model);
        drawInspector(model);
    }

    function tick() {
        C.load(sdk)
            .then(function (model) {
                if (state.error) {
                    state.error = '';
                    drawError();
                }
                if (model.sig !== state.sig) {
                    state.model = model;
                    state.sig = model.sig;
                    render();
                }
            })
            .catch(fail)
            .then(function () {
                setTimeout(tick, POLL);
            });
    }

    // One set of handlers for the diagram, however often it is redrawn.
    var diagram = $('diagram');
    diagram.addEventListener('click', function (event) {
        var g = event.target.closest && event.target.closest('[data-key]');
        if (g && g.closest('svg')) select(g.dataset.key);
    });
    diagram.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        var g = event.target.closest && event.target.closest('[data-key]');
        if (g) {
            event.preventDefault();
            select(g.dataset.key);
        }
    });
    function focus(key) {
        var root = diagram.querySelector('svg.radial');
        if (!root) return;
        root.querySelectorAll('.lit').forEach(function (x) {
            x.classList.remove('lit');
        });
        if (!key) {
            root.classList.remove('focusing');
            return;
        }
        root.classList.add('focusing');
        var related = {};
        related[key] = true;
        root.querySelectorAll('.r-chord, .r-edge').forEach(function (e) {
            if (e.dataset.a === key || e.dataset.b === key || e.dataset.c === key) {
                e.classList.add('lit');
                related[e.dataset.a] = true;
                related[e.dataset.b] = true;
            }
        });
        root.querySelectorAll('[data-key]').forEach(function (g) {
            if (related[g.dataset.key]) g.classList.add('lit');
        });
    }
    diagram.addEventListener('pointerover', function (event) {
        var g = event.target.closest && event.target.closest('[data-key]');
        focus(g ? g.dataset.key : '');
    });
    diagram.addEventListener('pointerleave', function () {
        focus('');
    });
    if (typeof ResizeObserver === 'function') {
        var pending = 0;
        new ResizeObserver(function () {
            clearTimeout(pending);
            pending = setTimeout(function () {
                var w = Math.max(560, Math.round(diagram.clientWidth - 28));
                if (state.model && state.model.installed && state.laidOut && Math.abs(w - state.laidOut) > 24) drawDiagram(state.model);
            }, 120);
        }).observe(diagram);
    }

    $('logo').appendChild(K.logo());
    $('top-actions').appendChild(
        K.button('IPAM', 'ghost', 'grid', function () {
            sdk.openView('ipam').catch(fail);
        }),
    );
    $('top-actions').appendChild(
        K.button('Overview', 'ghost', 'home', function () {
            sdk.openView('overview').catch(fail);
        }),
    );
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && state.selected) select('');
    });

    var h = K.readHash();
    if (h.sel) state.selected = h.sel;
    if (Number(h.width) > 0) state.width = Number(h.width);
    $('inspector').parentNode.insertBefore(
        K.grip({
            panel: $('inspector'),
            prop: '--inspector-w',
            min: 320,
            room: 520,
            initial: state.width,
            label: 'Resize the inspector',
            onResize: function (px, done) {
                if (!done) return;
                state.width = px;
                writeHash();
            },
        }),
        $('inspector'),
    );

    sdk.ready()
        .then(function (context) {
            state.ctx = context;
            $('where').textContent = context.contextName;
            tick();
            sdk.summary()
                .then(function (s) {
                    state.summary = s;
                    if (state.model && !state.model.installed) render();
                })
                .catch(function () {});
        })
        .catch(fail);
})();
