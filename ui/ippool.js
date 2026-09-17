// An IP pool's panel: how full it is, how many of its blocks are carved out,
// how its traffic is encapsulated, and a small map of its blocks.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var C = window.Calico;
    var K = window.CalicoKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;
    var MAX_TILES = 64;

    var state = { ctx: null, sig: '', model: null };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function fail(err) {
        $('error').textContent = (err && err.message) || String(err);
        $('error').hidden = false;
    }

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    var plural = C.plural;

    function plain(root, iconName, text) {
        var p = el('div', 'plain');
        add(p, K.icon(iconName), el('span', '', text));
        root.appendChild(p);
    }

    function draw(model, p) {
        var root = $('root');
        tip.hidden = true;
        root.textContent = '';
        var fraction = C.share(p.used, p.capacity);
        var head = el('div', 'panel-verdict ' + (p.disabled ? 'warn' : K.fillTone(fraction)));
        head.style.gap = '14px';
        head.appendChild(K.ring(fraction, 50, K.fillTone(fraction), C.percent(fraction) + ' in use'));
        var body = el('div');
        add(body, el('strong', '', C.count(p.used) + ' of ' + C.count(p.capacity) + ' addresses in use'), el('span', '', C.percent(fraction) + ' full · ' + plural(p.blocks.length, 'block') + ' of ' + C.count(p.possibleBlocks) + ' carved' + (p.borrowed ? ' · ' + p.borrowed + ' borrowed' : '') + (p.disabled ? ' · disabled: nothing new is assigned' : '')));
        head.appendChild(body);
        root.appendChild(head);

        var tags = el('div', 'pool-tags');
        tags.style.margin = '0 0 8px';
        tags.appendChild(el('code', 'chip outline', p.cidr));
        tags.appendChild(K.chip(p.encap.id === 'none' ? 'no encapsulation' : p.encap.text, p.encap.id === 'none' ? 'muted' : p.encap.id, 'tunnel'));
        tags.appendChild(K.chip('/' + p.blockSize + ' blocks', 'muted', 'grid'));
        tags.appendChild(p.nat ? K.chip('NAT outgoing', 'ok', 'nat') : K.chip('no NAT', 'muted', 'nat'));
        if (p.disabled) tags.appendChild(K.chip('disabled', 'warn', 'ban'));
        if (p.assignmentMode === 'Manual') tags.appendChild(K.chip('manual assignment', 'info'));
        if (p.disableBGPExport) tags.appendChild(K.chip('not exported over BGP', 'muted'));
        var uses = p.allowedUses.join(', ');
        if (uses !== 'Workload, Tunnel') tags.appendChild(K.chip('for ' + uses, 'info'));
        root.appendChild(tags);

        var blockFraction = p.possibleBlocks > 0n ? Math.min(1, Number((BigInt(p.blocks.length) * 100000n) / p.possibleBlocks) / 100000) : 0;
        var grid = el('div', 'panel-grid');
        add(grid, K.usage('Addresses', C.count(p.used), C.count(p.capacity), fraction), K.usage('Blocks', String(p.blocks.length), C.count(p.possibleBlocks), blockFraction, blockFraction >= 0.9 ? 'warn' : 'info'));
        root.appendChild(grid);

        var nodes = el('p', 'faint small');
        nodes.style.marginTop = '10px';
        nodes.textContent =
            'Serves ' +
            (p.nodeSelector && p.nodeSelector !== 'all()' ? plural(p.nodes.length, 'node') + ' matching ' + p.nodeSelector : 'every node') +
            (p.namespaceSelector ? ', for namespaces matching ' + p.namespaceSelector : '') +
            (p.nodes.length && p.nodes.length <= 8 && p.nodeSelector && p.nodeSelector !== 'all()' ? ': ' + C.names(p.nodes, 8) : '') +
            '.';
        if (!p.nodeSel.ok) nodes.textContent = 'The nodeSelector does not parse: ' + p.nodeSel.error;
        root.appendChild(nodes);

        var mh = el('h3', 'mini-title', 'Blocks');
        mh.style.margin = '12px 0 6px';
        root.appendChild(mh);
        if (!p.blocks.length) {
            root.appendChild(el('p', 'quiet', 'No block yet: Calico carves one the first time a node needs an address from this pool.'));
        } else {
            var map = el('div', 'mini-map');
            p.blocks.slice(0, MAX_TILES).forEach(function (b) {
                map.appendChild(K.blockTile(b, model, {}));
            });
            var more = p.possibleBlocks - BigInt(Math.min(p.blocks.length, MAX_TILES));
            if (more > 0n) {
                var rest = el('div', 'btile-more');
                rest.style.height = '44px';
                add(rest, el('strong', '', '+ ' + C.count(more)), p.blocks.length > MAX_TILES ? 'more' : 'free');
                map.appendChild(rest);
            }
            root.appendChild(map);
        }

        var issues = model.findings.filter(function (f) {
            return f.ref && f.ref.kind === C.KINDS.pools && f.ref.name === p.name;
        });
        issues.forEach(function (f) {
            var w = el('div', 'why ' + f.tone);
            add(w, K.icon('alert'), el('span', '', f.text));
            root.appendChild(w);
        });

        var foot = el('div', 'd-tools');
        foot.style.margin = '12px 0 0';
        foot.style.justifyContent = 'flex-start';
        foot.appendChild(
            K.button('IP address management', 'ghost small', 'grid', function () {
                sdk.openView('ipam').catch(fail);
            }),
        );
        root.appendChild(foot);
    }

    function tick() {
        C.load(sdk)
            .then(function (model) {
                $('error').hidden = true;
                var root = $('root');
                if (!model.installed) {
                    root.textContent = '';
                    plain(root, 'info', 'Calico’s IPAM kinds are not served here.');
                    return;
                }
                var p = model.poolByName[state.ctx.object.name];
                if (!p) {
                    root.textContent = '';
                    plain(root, 'info', 'This pool could not be read.');
                    return;
                }
                if (model.sig === state.sig) return;
                state.sig = model.sig;
                state.model = model;
                draw(model, p);
            })
            .catch(fail)
            .then(function () {
                setTimeout(tick, POLL);
            });
    }

    var tip = K.tooltip($('root'), '.btile', function (node, into) {
        var b = state.model && state.model.blockByName[node.dataset.block];
        if (!b) return false;
        add(into, el('code', 'tip-head', b.cidr), el('div', 'tip-line', b.used + ' of ' + b.size + ' in use' + (b.borrowed ? ' · ' + b.borrowed + ' borrowed' : '')), el('div', 'tip-note', b.node ? 'affine to ' + b.node : 'no affinity'));
        return true;
    });
    $('root').addEventListener('click', function (event) {
        var t = event.target.closest && event.target.closest('.btile');
        if (t) open({ kind: C.KINDS.blocks, namespace: '', name: t.dataset.block });
    });

    sdk.ready()
        .then(function (context) {
            state.ctx = context;
            if (!context.object) {
                fail(new Error('This page is a panel, drawn for one IP pool.'));
                return;
            }
            tick();
        })
        .catch(fail);
})();
