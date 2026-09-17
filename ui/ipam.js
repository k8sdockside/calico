// IP address management: every IP pool with its usage, and under it a map of
// the IPAM blocks Calico has carved from it -- a tile per block, tinted by
// the node it is affine to and filled by how much of it is in use. A block
// opens in the inspector as a seat map of its addresses, coloured by the
// namespace holding each one. Search finds an address, a pod or a node.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var C = window.Calico;
    var K = window.CalicoKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;
    var MAX_TILES = 480;
    var MAX_ALLOCS = 300;

    var state = {
        ctx: null,
        model: null,
        sig: '',
        error: '',
        query: '',
        selected: '',
        by: 'pool',
        width: 0,
        reveal: false,
        summary: null,
    };

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

    function writeHash() {
        K.writeHash({ sel: state.selected, by: state.by === 'node' ? 'node' : '', width: state.width });
    }

    function blockRef(b) {
        return { kind: C.KINDS.blocks, namespace: '', name: b.name };
    }

    function poolRef(p) {
        return { kind: C.KINDS.pools, namespace: '', name: p.name };
    }

    // ----- search ------------------------------------------------------------------

    // What the query picks out: { blocks: Set of names, seats: Set of ip keys,
    // nodes: Set } or null. An address picks its block and seat.
    function search(model) {
        var q = state.query.trim().toLowerCase();
        if (!q) return null;
        var hits = { blocks: new Set(), seats: new Set(), text: q };
        var ip = C.parseIP(q);
        if (ip) {
            var b = C.blockOfIP(model, ip);
            if (b) {
                hits.blocks.add(b.name);
                hits.seats.add(C.ipKey(ip));
            }
            return hits;
        }
        model.blocks.forEach(function (b) {
            if (b.cidr.indexOf(q) === 0 || b.node.toLowerCase().indexOf(q) >= 0) hits.blocks.add(b.name);
        });
        model.allocations.forEach(function (at) {
            if (at.text.indexOf(q) === 0 || at.pod.toLowerCase().indexOf(q) >= 0 || at.namespace.toLowerCase() === q || (at.node.toLowerCase().indexOf(q) >= 0 && at.borrowed)) {
                hits.blocks.add(at.block.name);
                hits.seats.add(at.key);
            }
        });
        return hits;
    }

    function onQuery() {
        state.query = $('query').value;
        var model = state.model;
        if (model) {
            var hits = search(model);
            if (hits && hits.blocks.size === 1) {
                state.selected = hits.blocks.values().next().value;
                state.reveal = true;
                writeHash();
            }
        }
        render();
    }

    // ----- the numbers ---------------------------------------------------------------

    function stat(label, big, small, extra) {
        var tile = el('div', 'stat');
        tile.appendChild(el('div', 'stat-label', label));
        var row = el('div', 'stat-row');
        if (extra && extra.graphic) row.appendChild(extra.graphic);
        var nums = el('div');
        add(nums, el('div', 'stat-big', big), small ? el('div', 'stat-small', small) : null);
        row.appendChild(nums);
        tile.appendChild(row);
        if (extra && extra.foot) tile.appendChild(extra.foot);
        return tile;
    }

    function foot(tone, iconName, text) {
        var f = el('div', 'stat-foot ' + tone);
        add(f, K.icon(iconName), el('span', '', text));
        return f;
    }

    function drawStats(model) {
        var box = $('stats');
        box.textContent = '';
        var used = 0;
        var v4cap = 0n;
        var v4used = 0;
        model.pools.forEach(function (p) {
            used += p.used;
            if (p.v === 4) {
                v4cap += p.capacity;
                v4used += p.used;
            }
        });
        var fraction = C.share(v4used, v4cap);
        box.appendChild(
            stat('Addresses in use', C.count(used), 'in ' + plural(model.pools.length, 'pool') + (v4cap ? ' · ' + C.percent(fraction) + ' of IPv4' : ''), {
                graphic: K.ring(fraction, 54, K.fillTone(fraction), C.percent(fraction) + ' of IPv4 space in use'),
                foot: foot('', 'pod', model.weps.length + ' workloads · ' + tunnelsTotal(model) + ' tunnel addresses'),
            }),
        );

        var possible = 0n;
        model.pools.forEach(function (p) {
            possible += p.possibleBlocks;
        });
        var withBlocks = model.nodes.filter(function (n) {
            return n.blocks.length;
        }).length;
        box.appendChild(stat('IPAM blocks', String(model.blocks.length), 'of ' + C.count(possible) + ' possible', { foot: foot('', 'node', 'affine to ' + plural(withBlocks, 'node')) }));

        var borrowed = 0;
        model.pools.forEach(function (p) {
            borrowed += p.borrowed;
        });
        box.appendChild(
            stat('Borrowed', String(borrowed), 'addresses in use away from their block’s node', {
                foot: borrowed ? foot('warn', 'alert', 'a node ran out of blocks of its own') : foot('ok', 'check', 'every address is on its block’s node'),
            }),
        );

        var cfg = (model.ipamConfig && model.ipamConfig.spec) || {};
        var reserved = model.reservations.length;
        box.appendChild(
            stat('IPAM configuration', cfg.strictAffinity ? 'Strict' : 'Borrowing', cfg.strictAffinity ? 'nodes only use their own blocks' : 'nodes may borrow from other blocks', {
                foot: foot('', 'info', (cfg.maxBlocksPerHost ? 'max ' + cfg.maxBlocksPerHost + ' blocks per node' : 'no block limit per node') + (model.reservationsServed ? ' · ' + plural(reserved, 'reserved range') : '')),
            }),
        );
    }

    function tunnelsTotal(model) {
        var n = 0;
        model.pools.forEach(function (p) {
            n += p.tunnels;
        });
        return n;
    }

    function drawAttention(model) {
        var box = $('attention');
        box.textContent = '';
        var list = model.findings.filter(function (f) {
            return f.group === 'ipam' && f.tone !== 'info';
        });
        box.hidden = !list.length;
        if (!list.length) return;
        var head = el('div', 'card-head');
        add(head, K.icon('alert'), el('h2', '', 'Needs attention'), el('span', 'count', String(list.length)));
        head.firstChild.style.color = 'var(--k-warn)';
        box.appendChild(head);
        var ul = el('ul', 'issues');
        list.forEach(function (f) {
            var li = el('li', 'issue ' + f.tone);
            var body = el('div', 'issue-body');
            body.appendChild(el('div', 'issue-text', f.text));
            li.appendChild(body);
            if (f.ref) {
                li.appendChild(
                    K.iconButton('open', 'Open', function () {
                        open(f.ref);
                    }),
                );
            }
            ul.appendChild(li);
        });
        box.appendChild(ul);
    }

    // ----- pools ---------------------------------------------------------------------

    function poolTags(model, p) {
        var tags = el('div', 'pool-tags');
        var encapTone = p.encap.id === 'vxlan' ? 'vxlan' : p.encap.id === 'ipip' ? 'ipip' : 'muted';
        tags.appendChild(K.chip(p.encap.id === 'none' ? 'no encapsulation' : p.encap.text, encapTone, 'tunnel', 'ipipMode ' + p.ipipMode + ' · vxlanMode ' + p.vxlanMode));
        tags.appendChild(K.chip('/' + p.blockSize + ' blocks · ' + C.count(p.blockAddresses) + ' each', 'muted', 'grid'));
        tags.appendChild(p.nat ? K.chip('NAT outgoing', 'ok', 'nat') : K.chip('no NAT', 'muted', 'nat'));
        if (p.disabled) tags.appendChild(K.chip('disabled', 'warn', 'ban', 'Calico assigns nothing new from this pool'));
        if (p.assignmentMode === 'Manual') tags.appendChild(K.chip('manual assignment', 'info', null, 'Only workloads that ask for this pool get addresses from it'));
        if (p.nodeSelector && p.nodeSelector !== 'all()') {
            tags.appendChild(K.chip('nodes: ' + p.nodeSelector + ' (' + p.nodes.length + ')', p.nodeSel.ok ? 'outline' : 'error', 'node', p.nodeSel.ok ? p.nodes.map(function (n) {
                return n.name;
            }).join(', ') : p.nodeSel.error));
        }
        if (p.namespaceSelector) tags.appendChild(K.chip('namespaces: ' + p.namespaceSelector, 'outline', 'ns'));
        var uses = p.allowedUses.join(', ');
        if (uses !== 'Workload, Tunnel') tags.appendChild(K.chip('for ' + uses, 'info'));
        if (p.disableBGPExport) tags.appendChild(K.chip('not exported over BGP', 'muted', 'mesh'));
        if (p.reserved.length) tags.appendChild(K.chip(plural(p.reserved.length, 'reserved range'), 'muted', 'lock', p.reserved.map(function (r) {
            return r.text;
        }).join(', ')));
        return tags;
    }

    function nodeLegend(model, blocks) {
        var legend = el('div', 'legend');
        var seen = {};
        blocks.forEach(function (b) {
            if (b.node) seen[b.node] = (seen[b.node] || 0) + 1;
        });
        Object.keys(seen)
            .sort()
            .forEach(function (n) {
                var key = el('span', 'key');
                var i = el('i');
                i.style.setProperty('--c', C.colorOfNode(model, n));
                add(key, i, el('span', '', n + (model.nodeByName[n] ? '' : ' (gone)')), el('span', 'faint', String(seen[n])));
                legend.appendChild(key);
            });
        if (blocks.some(function (b) {
            return b.borrowed;
        })) {
            add(legend, add(el('span', 'key'), el('i', 'borrow'), el('span', '', 'has borrowed addresses')));
        }
        return legend;
    }

    function tilesFor(model, blocks, hits, into, limit) {
        var shown = 0;
        blocks.forEach(function (b) {
            if (shown >= limit) return;
            shown++;
            into.appendChild(
                K.blockTile(b, model, {
                    selected: state.selected === b.name,
                    faded: hits && !hits.blocks.has(b.name),
                    hit: hits && hits.blocks.has(b.name),
                }),
            );
        });
        return shown;
    }

    function poolCard(model, p, hits) {
        var faded = hits && !p.blocks.some(function (b) {
            return hits.blocks.has(b.name);
        }) && p.name.toLowerCase().indexOf(hits.text) < 0;
        var card = el('article', 'pool' + (faded ? ' faded' : ''));
        var head = el('header', 'pool-head');
        var left = el('div');
        var id = el('div', 'pool-id');
        var badge = el('span', 'pool-badge' + (p.v === 6 ? ' v6' : ''));
        badge.appendChild(K.icon('pool'));
        var names = el('div', 'pool-names');
        var name = K.link(p.name, function () {
            open(poolRef(p));
        }, 'Open the IPPool');
        name.classList.add('pool-name');
        add(names, name, el('code', 'pool-cidr', p.cidr + '  ·  IPv' + (p.v || '?')));
        add(id, badge, names);
        add(left, id, poolTags(model, p));
        var use = el('div', 'pool-use');
        var fraction = C.share(p.used, p.capacity);
        var blockFraction = p.possibleBlocks > 0n ? Math.min(1, Number((BigInt(p.blocks.length) * 100000n) / p.possibleBlocks) / 100000) : 0;
        add(use, K.usage('Addresses', C.count(p.used), C.count(p.capacity), fraction), K.usage('Blocks', String(p.blocks.length), C.count(p.possibleBlocks), blockFraction, blockFraction >= 0.9 ? 'warn' : 'info'));
        if (p.borrowed) use.appendChild(el('div', 'stat-foot warn', p.borrowed + ' borrowed'));
        add(head, left, use);
        card.appendChild(head);

        var mapHead = el('div', 'bmap-head');
        add(mapHead, el('span', 'mini-title', state.by === 'node' ? 'Blocks by node' : 'Blocks'), nodeLegend(model, p.blocks));
        card.appendChild(mapHead);

        var free = p.possibleBlocks - BigInt(p.blocks.length);
        if (!p.blocks.length) {
            card.appendChild(el('p', 'quiet', p.disabled ? 'Disabled, and no block was ever carved from it.' : 'No block yet: Calico carves one the first time a node needs an address from this pool.'));
            return card;
        }
        if (state.by === 'node') {
            var byNode = {};
            p.blocks.forEach(function (b) {
                var key = b.node || (b.virtual ? 'virtual:' + b.virtual : '(no affinity)');
                (byNode[key] = byNode[key] || []).push(b);
            });
            var left2 = MAX_TILES;
            var groups = el('div', 'bmap-nodes');
            card.appendChild(groups);
            Object.keys(byNode)
                .sort()
                .forEach(function (n) {
                    var group = el('div', 'bmap-node');
                    var gh = el('div', 'bmap-node-head');
                    var sw = el('i');
                    sw.style.setProperty('--c', C.colorOfNode(model, n));
                    var used = 0;
                    var size = 0;
                    byNode[n].forEach(function (b) {
                        used += b.used;
                        size += b.size;
                    });
                    var nodeName = model.nodeByName[n] ? K.link(n, function () {
                        open({ kind: C.KINDS.nodes, namespace: '', name: n });
                    }) : el('span', '', n);
                    add(gh, sw, nodeName, el('span', 'faint', plural(byNode[n].length, 'block') + ' · ' + used + ' / ' + size + ' used'));
                    group.appendChild(gh);
                    var grid = el('div', 'bmap');
                    left2 -= tilesFor(model, byNode[n], hits, grid, Math.max(0, left2));
                    group.appendChild(grid);
                    groups.appendChild(group);
                });
        } else {
            var grid = el('div', 'bmap');
            var shown = tilesFor(model, p.blocks, hits, grid, MAX_TILES);
            if (shown < p.blocks.length) {
                var more = el('div', 'btile-more');
                add(more, el('strong', '', '+' + (p.blocks.length - shown)), 'more blocks — search to find one');
                grid.appendChild(more);
            }
            if (free > 0n) {
                var rest = el('div', 'btile-more');
                add(rest, el('strong', '', '+ ' + C.count(free)), 'free blocks');
                rest.title = C.count(free) + ' more /' + p.blockSize + ' blocks fit in ' + p.cidr;
                grid.appendChild(rest);
            }
            card.appendChild(grid);
        }
        return card;
    }

    function drawPools(model) {
        var root = $('pools');
        tip.hidden = true;
        root.textContent = '';
        var hits = search(model);
        if (!model.pools.length) {
            var none = el('div', 'getting-started');
            add(none, el('h2', '', 'No IP pools'), el('p', '', 'Calico has nowhere to take pod addresses from. The operator creates pools from the Installation’s calicoNetwork.ipPools; without the operator, create one:'));
            var pre = el('pre', 'snippet');
            pre.textContent = ['apiVersion: projectcalico.org/v3', 'kind: IPPool', 'metadata:', '  name: default-ipv4', 'spec:', '  cidr: 10.244.0.0/16', '  blockSize: 26', '  vxlanMode: CrossSubnet', '  natOutgoing: true', '  nodeSelector: all()'].join('\n');
            none.appendChild(pre);
            root.appendChild(none);
        }
        model.pools.forEach(function (p) {
            root.appendChild(poolCard(model, p, hits));
        });
        if (model.orphanBlocks.length) {
            var card = el('article', 'pool');
            var head = el('div', 'card-head');
            add(head, K.icon('alert'), el('h2', '', 'Blocks in no pool'), el('span', 'card-sub', 'Their pool was deleted or changed while addresses were still in use. They go away once the addresses are released.'));
            head.firstChild.style.color = 'var(--k-warn)';
            card.appendChild(head);
            var grid = el('div', 'bmap');
            tilesFor(model, model.orphanBlocks, hits, grid, MAX_TILES);
            card.appendChild(grid);
            root.appendChild(card);
        }
        if (hits && !hits.blocks.size) {
            var nothing = el('p', 'quiet', 'Nothing in any block matches “' + state.query.trim() + '”.');
            root.insertBefore(nothing, root.firstChild);
        }
        if (state.reveal) {
            state.reveal = false;
            var target = root.querySelector('.btile.sel');
            if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }

    // ----- the inspector ----------------------------------------------------------------

    function inspectorHead(box, title, closable) {
        var head = el('div', 'insp-head');
        head.appendChild(el('h2', '', title));
        if (closable) {
            head.appendChild(
                K.iconButton('close', 'Back to every node', function () {
                    select('');
                }),
            );
        }
        box.appendChild(head);
    }

    function select(name) {
        state.selected = name;
        writeHash();
        render();
        if (name && window.matchMedia('(max-width: 1020px)').matches) $('inspector').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    function drawInspector(model) {
        var box = $('inspector');
        var scroll = box.scrollTop;
        box.textContent = '';
        var b = state.selected ? model.blockByName[state.selected] : null;
        box.classList.toggle('active', !!b);
        if (!b) {
            if (state.selected) state.selected = '';
            directory(box, model);
            return;
        }
        inspectBlock(box, model, b);
        box.scrollTop = scroll;
    }

    function directory(box, model) {
        inspectorHead(box, 'Nodes and their blocks', false);
        box.appendChild(el('p', 'insp-note', 'Pick a block on the left to see who holds each of its addresses. Pick a node here to find its blocks.'));
        var list = el('div', 'node-row');
        var nodes = model.nodes.slice();
        // Blocks affine to nodes that are gone are listed too.
        var gone = {};
        model.blocks.forEach(function (b) {
            if (b.node && !model.nodeByName[b.node]) gone[b.node] = (gone[b.node] || 0) + 1;
        });
        nodes.forEach(function (n) {
            var row = K.button('', 'node-line', null, function () {
                $('query').value = n.name;
                state.query = n.name;
                render();
            });
            var sw = el('i');
            sw.style.setProperty('--c', C.colorOfNode(model, n.name));
            var fraction = n.capacity ? n.used / n.capacity : 0;
            add(row, sw, el('span', 'node-line-name', n.name), el('span', 'node-line-meta', plural(n.blocks.length, 'block') + ' · ' + n.used + ' / ' + n.capacity + (n.borrowed ? ' · ' + n.borrowed + ' borrowed' : '')), K.meter(fraction, K.fillTone(fraction)));
            row.title = n.pods + ' workloads on ' + n.name;
            list.appendChild(row);
        });
        Object.keys(gone).forEach(function (name) {
            var row = K.button('', 'node-line', null, function () {
                $('query').value = name;
                state.query = name;
                render();
            });
            var sw = el('i');
            sw.style.setProperty('--c', C.colorOfNode(model, name));
            add(row, sw, el('span', 'node-line-name', name), el('span', 'node-line-meta warn-text', plural(gone[name], 'block') + ' · node gone'));
            list.appendChild(row);
        });
        box.appendChild(list);

        if (model.reservations.length) {
            box.appendChild(el('h3', 'mini-title', 'Reserved'));
            box.lastChild.style.margin = '16px 0 6px';
            model.reservations.forEach(function (r) {
                var line = el('div', 'plain small');
                add(
                    line,
                    K.icon('lock'),
                    el('code', '', r.text),
                    K.link(r.name, function () {
                        open({ kind: C.KINDS.reservations, namespace: '', name: r.name });
                    }),
                );
                box.appendChild(line);
            });
        }
    }

    function inspectBlock(box, model, b) {
        inspectorHead(box, 'IPAM block', true);
        box.appendChild(el('div', 'blk-title', b.cidr));
        var sub = el('div', 'd-sub');
        if (b.pool) {
            add(sub, el('span', '', 'pool'), K.link(b.pool.name, function () {
                open(poolRef(b.pool));
            }));
        } else {
            sub.appendChild(K.chip('in no pool', 'warn', 'alert'));
        }
        if (b.node) {
            add(
                sub,
                el('span', '', '· affine to'),
                model.nodeByName[b.node]
                    ? K.link(b.node, function () {
                          open({ kind: C.KINDS.nodes, namespace: '', name: b.node });
                      })
                    : el('span', 'warn-text', b.node + ' (gone)'),
            );
        } else if (b.virtual) {
            add(sub, el('span', '', '· virtual affinity ' + b.virtual));
        } else {
            add(sub, el('span', '', '· no affinity'));
        }
        box.appendChild(sub);

        var usage = el('div');
        usage.style.marginTop = '12px';
        usage.appendChild(K.usage('In use', String(b.used), String(b.size), b.fraction));
        box.appendChild(usage);
        var chips = el('div', 'pool-tags');
        if (b.borrowed) chips.appendChild(K.chip(b.borrowed + ' borrowed', 'warn', 'alert', 'In use on another node than ' + b.node));
        if (b.tunnels) chips.appendChild(K.chip(plural(b.tunnels, 'tunnel address', 'tunnel addresses'), 'muted', 'tunnel'));
        if (b.releasing) chips.appendChild(K.chip(b.releasing + ' cooling down', 'muted', 'clock'));
        if (chips.childNodes.length) box.appendChild(chips);

        var hits = search(model);
        var cols = b.size <= 16 ? 8 : 16;
        var width = box.clientWidth - 32 - 64;
        var cell = Math.max(10, Math.min(20, Math.floor(width / cols) - 3));
        box.appendChild(K.seatMap(b, model, { cols: cols, cell: cell, hits: hits && hits.seats.size ? hits.seats : null }));

        // Who is in it.
        var legend = el('div', 'legend');
        var counts = {};
        b.allocs.forEach(function (a) {
            if (a.namespace) counts[a.namespace] = (counts[a.namespace] || 0) + 1;
        });
        Object.keys(counts)
            .sort(function (x, y) {
                return counts[y] - counts[x];
            })
            .forEach(function (ns) {
                var key = el('span', 'key');
                var i = el('i');
                i.style.setProperty('--c', model.colors[ns] || 'var(--k-faint)');
                add(key, i, el('span', '', ns), el('span', 'faint', String(counts[ns])));
                legend.appendChild(key);
            });
        if (b.tunnels) add(legend, add(el('span', 'key'), el('i', 'tunnel'), el('span', '', 'tunnel')));
        add(legend, add(el('span', 'key'), el('i', 'free'), el('span', '', 'free')));
        if (model.reservations.length) add(legend, add(el('span', 'key'), el('i', 'reserved'), el('span', '', 'reserved')));
        if (b.borrowed) add(legend, add(el('span', 'key'), el('i', 'borrow'), el('span', '', 'borrowed')));
        box.appendChild(legend);

        var tools = el('div', 'd-tools');
        tools.style.margin = '12px 0 0';
        tools.style.justifyContent = 'flex-start';
        add(
            tools,
            K.button('Open block', 'ghost small', 'open', function () {
                open(blockRef(b));
            }),
            K.button('YAML', 'ghost small', 'edit', function () {
                sdk.edit(blockRef(b)).catch(fail);
            }),
        );
        box.appendChild(tools);

        if (b.borrowed) {
            box.appendChild(el('h3', 'mini-title', 'Borrowed'));
            box.lastChild.style.margin = '16px 0 4px';
            var by = {};
            b.allocs.forEach(function (a) {
                if (a.borrowed) (by[a.node] = by[a.node] || []).push(a);
            });
            Object.keys(by).forEach(function (n) {
                box.appendChild(el('p', 'quiet', n + ' uses ' + by[n].map(function (a) {
                    return a.text;
                }).join(', ') + ' from this block, which belongs to ' + b.node + '.'));
            });
        }

        box.appendChild(el('h3', 'mini-title', 'Addresses in use'));
        box.lastChild.style.margin = '16px 0 4px';
        var list = el('ul', 'alloc-list');
        b.allocs.slice(0, MAX_ALLOCS).forEach(function (a) {
            var li = el('li');
            var row = K.button('', 'alloc' + (hits && hits.seats.has(a.key) ? ' hit' : ''), null, function () {
                if (a.podRef) open(C.podRef(a.podRef.obj));
                else if (a.tunnel && model.nodeByName[a.node]) open({ kind: C.KINDS.nodes, namespace: '', name: a.node });
            });
            var d = el('i', 'dot' + (a.tunnel ? ' tunnel' : ''));
            if (!a.tunnel) d.style.background = model.colors[a.namespace] || 'var(--k-faint)';
            var who = a.tunnel ? a.tunnel + ' · ' + (a.node || b.node) : a.pod || a.vmi || a.handle || 'unknown';
            add(row, d, el('code', '', a.text), el('span', 'alloc-who' + (a.pod && !a.podRef ? ' warn-text' : ''), who), el('span', 'alloc-ns', a.tunnel ? '' : (a.namespace || '') + (a.borrowed ? ' · on ' + a.node : '')));
            row.title = a.pod && !a.podRef ? 'No such pod now — the address may have leaked; kube-controllers releases leaked addresses.' : a.handle;
            li.appendChild(row);
            list.appendChild(li);
        });
        if (!b.allocs.length) list.appendChild(el('li', 'quiet', 'Nothing — every address is free.'));
        box.appendChild(list);
        if (b.allocs.length > MAX_ALLOCS) box.appendChild(el('p', 'faint small', 'and ' + (b.allocs.length - MAX_ALLOCS) + ' more'));
    }

    // ----- putting it together -----------------------------------------------------------

    function drawEmpty(model) {
        var box = $('empty');
        box.textContent = '';
        box.hidden = false;
        box.appendChild(K.absent(sdk, state.ctx, model, state.summary, fail));
    }

    function drawTop() {
        var seg = $('group');
        seg.textContent = '';
        [
            ['pool', 'By pool'],
            ['node', 'By node'],
        ].forEach(function (g) {
            var b = K.button(g[1], 'seg-btn' + (state.by === g[0] ? ' on' : ''), null, function () {
                state.by = g[0];
                writeHash();
                render();
            });
            b.setAttribute('aria-pressed', String(state.by === g[0]));
            seg.appendChild(b);
        });
    }

    function render() {
        var model = state.model;
        if (!model) return;
        drawError();
        var where = state.ctx.contextName;
        if (model.version) where += ' · Calico ' + model.version;
        where += ' · ' + plural(model.pools.length, 'pool') + ', ' + plural(model.blocks.length, 'block');
        $('where').textContent = where;
        $('query').parentNode.hidden = !model.installed;
        if (!model.installed) {
            drawEmpty(model);
            $('layout').hidden = true;
            return;
        }
        $('empty').hidden = true;
        $('layout').hidden = false;
        drawTop();
        drawStats(model);
        drawAttention(model);
        drawPools(model);
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

    // One click handler and one tip for every tile and seat.
    $('pools').addEventListener('click', function (event) {
        var t = event.target.closest && event.target.closest('.btile');
        if (t) select(state.selected === t.dataset.block ? '' : t.dataset.block);
    });
    var tip = K.tooltip(document.body, '.btile, .seat', function (node, into) {
        var model = state.model;
        if (!model) return false;
        if (node.classList.contains('seat')) return K.describeSeat(model, node, into);
        var b = model.blockByName[node.dataset.block];
        if (!b) return false;
        add(into, el('code', 'tip-head', b.cidr));
        add(into, el('div', 'tip-line', b.used + ' of ' + b.size + ' in use' + (b.borrowed ? ' · ' + b.borrowed + ' borrowed' : '')));
        add(into, el('div', 'tip-note', (b.node ? 'affine to ' + b.node : 'no affinity') + (b.pool ? ' · pool ' + b.pool.name : '')));
        return true;
    });
    $('inspector').addEventListener('click', function (event) {
        var seat = event.target.closest && event.target.closest('.seat');
        if (!seat || !state.model || seat.classList.contains('slice')) return;
        var b = state.model.blockByName[seat.dataset.block];
        var at = b && state.model.allocations.get(C.ipKey({ v: b.net.v, n: b.net.base + BigInt(Number(seat.dataset.ord)) }));
        if (at && at.podRef) open(C.podRef(at.podRef.obj));
    });

    $('logo').appendChild(K.logo());
    $('search-icon').appendChild(K.icon('search'));
    $('query').addEventListener('input', onQuery);
    $('query').addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
            $('query').value = '';
            onQuery();
        }
    });
    document.addEventListener('keydown', function (event) {
        if (event.key === '/' && document.activeElement === document.body) {
            event.preventDefault();
            $('query').focus();
        } else if (event.key === 'Escape' && state.selected && document.activeElement !== $('query')) {
            select('');
        }
    });
    $('top-actions').appendChild(
        K.button('Policy board', 'ghost', 'lanes', function () {
            sdk.openView('policies').catch(fail);
        }),
    );
    $('top-actions').appendChild(
        K.button('Overview', 'ghost', 'home', function () {
            sdk.openView('overview').catch(fail);
        }),
    );

    var h = K.readHash();
    if (h.sel) state.selected = h.sel;
    if (h.by === 'node') state.by = 'node';
    if (Number(h.width) > 0) state.width = Number(h.width);
    $('inspector').parentNode.insertBefore(
        K.grip({
            panel: $('inspector'),
            prop: '--inspector-w',
            min: 320,
            room: 480,
            initial: state.width,
            label: 'Resize the inspector',
            onResize: function (px, done) {
                if (!done) return;
                state.width = px;
                writeHash();
                if (state.model && state.model.installed) drawInspector(state.model);
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
