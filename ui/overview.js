// Calico's own overview, in place of the page the app generates for every
// plugin. It answers what the generated one does -- is Calico even here? --
// and then what that page cannot: how the network is built, whether every
// node is running calico-node, how full the address space is, how much of the
// cluster any policy protects, what is wrong, and what Calico did lately.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var C = window.Calico;
    var K = window.CalicoKit;
    var el = K.el;
    var add = K.add;

    var POLL = 5000;
    var EVENTS_EVERY = 15000;
    var SUMMARY_EVERY = 30000;
    var CHARTS_EVERY = 60000;
    var HISTORY_MINUTES = 360;
    var MAX_NODES = 47;
    var MAX_ISSUES = 9;

    var state = { ctx: null, model: null, sig: '', summary: null, panel: null, events: null, error: '' };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function fail(err) {
        state.error = (err && err.message) || String(err);
        $('error').textContent = state.error;
        $('error').hidden = false;
    }

    function clearError() {
        state.error = '';
        $('error').hidden = true;
    }

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    function openView(id) {
        sdk.openView(id).catch(fail);
    }

    var plural = C.plural;

    function b(text, className) {
        return el('strong', className || '', text);
    }

    // ----- reading -----------------------------------------------------------

    function attention(model) {
        return model.findings.filter(function (f) {
            return f.tone !== 'info';
        });
    }

    function readyNodes(model) {
        var withPod = model.nodes.filter(function (n) {
            return n.calico;
        });
        return {
            total: model.nodes.length,
            withPod: withPod.length,
            ready: withPod.filter(function (n) {
                return n.calicoReady;
            }).length,
        };
    }

    // The encapsulations the enabled pools use, busiest first, as
    // { label, text } -- "VXLAN" / "VXLAN (CrossSubnet)".
    function encapSummary(model) {
        var used = {};
        model.pools.forEach(function (p) {
            if (p.disabled) return;
            var key = p.encap.label;
            var e = (used[key] = used[key] || { label: p.encap.id === 'none' ? 'native routing' : p.encap.label, id: p.encap.id, weight: 0, cross: false });
            e.weight += p.blocks.length + 0.01;
            if (p.encap.cross) e.cross = true;
        });
        return Object.keys(used)
            .map(function (k) {
                return used[k];
            })
            .sort(function (a, b) {
                return (a.id === 'none') - (b.id === 'none') || b.weight - a.weight;
            });
    }

    function encapWords(list) {
        var words = list.map(function (e) {
            return e.label + (e.cross ? ' (CrossSubnet)' : '');
        });
        if (words.length < 2) return words.join('');
        return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
    }

    function totals(model) {
        var used = 0;
        model.pools.forEach(function (p) {
            used += p.used;
        });
        return {
            used: used,
            policies: model.policies.filter(function (p) {
                return !p.staged;
            }).length,
            staged: model.policies.filter(function (p) {
                return p.staged;
            }).length,
            tiersInUse: model.tiers.filter(function (t) {
                return t.policies.some(function (p) {
                    return !p.staged;
                });
            }).length,
            open: model.openNamespaces.filter(function (ns) {
                return !ns.system;
            }),
        };
    }

    // ----- the hero ------------------------------------------------------------

    function verdict(model) {
        var found = attention(model);
        var errors = found.filter(function (f) {
            return f.tone === 'error';
        }).length;
        var r = readyNodes(model);
        if (!found.length) {
            if (r.total) return { tone: 'ok', icon: 'check', text: 'Calico is healthy on ' + (r.total === 1 ? 'the one node' : 'all ' + r.total + ' nodes') };
            return { tone: 'ok', icon: 'check', text: 'Calico is healthy' };
        }
        if (errors && r.ready < r.withPod) {
            var down = r.withPod - r.ready;
            if (found.length === 1) return { tone: 'error', icon: 'alert', text: 'calico-node is down on ' + plural(down, 'node') };
        }
        return { tone: errors ? 'error' : 'warn', icon: 'alert', text: plural(found.length, 'thing needs', 'things need') + ' attention' };
    }

    function story(model) {
        var p = el('p', 'ov-story');
        var t = totals(model);
        var r = readyNodes(model);
        if (!model.pools.length) {
            add(p, 'Calico is installed, but there is no IP pool, so pods here cannot be given an address.');
            return p;
        }
        add(p, 'Calico' + (model.version ? ' ' + model.version : '') + ' networks ', b(plural(model.weps.length, 'workload')), ' on ', b(plural(r.total, 'node')), ' from ', b(plural(model.pools.length, 'IP pool')));
        var encaps = encapSummary(model);
        if (encaps.length) add(p, ' over ', b(encapWords(encaps)));
        add(p, ', with the ', b(model.dataplane.label), ' dataplane');
        if (model.bgp.enabled) add(p, ' and ', b('BGP' + (model.bgp.mesh ? ' (full mesh)' : model.routeReflectors.length ? ' (route reflectors)' : '')));
        add(p, '. ');
        if (t.policies) {
            add(p, b(plural(t.policies, 'policy', 'policies')), ' in ', b(plural(t.tiersInUse, 'tier')), ' protect ', b(C.percent(model.coverage.fraction) + ' of workloads'));
        } else {
            add(p, b('No network policy', 'warnish'), ' is in force, so every workload accepts any traffic');
        }
        if (t.open.length) {
            add(p, '; ', b(plural(t.open.length, 'namespace is', 'namespaces are') + ' left wide open', 'warnish'));
        }
        add(p, '.');
        if (r.ready < r.withPod) {
            add(p, ' ', b('calico-node is not ready on ' + plural(r.withPod - r.ready, 'node'), 'bad'), '.');
        }
        return p;
    }

    // The addresses in use as one ring, a slice per pool; how full each pool
    // is goes in the legend beside it.
    function orbit(model) {
        var wrap = el('div', 'ov-orbit');
        var size = 220;
        var mid = size / 2;
        var r = 88;
        var c = 2 * Math.PI * r;
        var t = totals(model);
        var s = K.svg('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'ov-rings', role: 'img' });
        s.setAttribute('aria-label', t.used + ' addresses in use across ' + model.pools.length + ' pools');
        s.appendChild(K.svg('circle', { cx: mid, cy: mid, r: r, class: 'ov-ring-track' }));
        var holding = model.pools.filter(function (p) {
            return p.used > 0;
        });
        var gap = holding.length > 1 ? 3 : 0;
        var start = 0;
        model.pools.forEach(function (pool, i) {
            if (!pool.used || !t.used) return;
            var length = (pool.used / t.used) * c;
            var ring = K.svg('circle', {
                cx: mid,
                cy: mid,
                r: r,
                class: 'ov-ring',
                'stroke-dasharray': Math.max(1, length - gap) + ' ' + c,
                'stroke-dashoffset': String(-start),
                transform: 'rotate(-90 ' + mid + ' ' + mid + ')',
            });
            ring.style.stroke = model.poolColors[pool.name];
            ring.style.animationDelay = i * 90 + 'ms';
            var title = K.svg('title', {});
            title.textContent = pool.name + ': ' + pool.used + ' of the ' + t.used + ' addresses in use';
            ring.appendChild(title);
            s.appendChild(ring);
            start += length;
        });
        // Inside: how much of the cluster's workload any policy protects.
        var ri = 66;
        var ci = 2 * Math.PI * ri;
        s.appendChild(K.svg('circle', { cx: mid, cy: mid, r: ri, class: 'ov-ring-inner-track' }));
        var inner = K.svg('circle', {
            cx: mid,
            cy: mid,
            r: ri,
            class: 'ov-ring-inner',
            'stroke-dasharray': Math.max(model.coverage.fraction ? 2 : 0, model.coverage.fraction * ci) + ' ' + ci,
            transform: 'rotate(-90 ' + mid + ' ' + mid + ')',
        });
        inner.style.stroke = model.coverage.fraction >= 0.8 ? 'var(--k-ok)' : 'var(--k-warn)';
        var it = K.svg('title', {});
        it.textContent = C.percent(model.coverage.fraction) + ' of workloads are selected by a policy';
        inner.appendChild(it);
        if (model.coverage.fraction > 0) s.appendChild(inner);
        wrap.appendChild(s);

        var centre = el('div', 'ov-centre');
        add(centre, el('div', 'ov-centre-big', C.count(t.used)), el('div', 'ov-centre-small', 'addresses in use'), el('div', 'ov-centre-small', C.percent(model.coverage.fraction) + ' protected'));
        wrap.appendChild(centre);

        var legend = el('ul', 'ov-legend');
        legend.appendChild(el('li', 'ov-legend-title', 'IP pools'));
        model.pools.slice(0, 6).forEach(function (pool) {
            var item = el('li');
            var row = K.button('', 'ov-legend-row', null, function () {
                open({ kind: C.KINDS.pools, namespace: '', name: pool.name });
            });
            var d = el('i', 'dot');
            d.style.background = model.poolColors[pool.name];
            var fraction = C.share(pool.used, pool.capacity);
            var tone = K.fillTone(fraction);
            row.title = pool.name + ' (' + pool.cidr + ') is ' + C.percent(fraction) + ' full' + (pool.disabled ? ' — disabled' : '');
            var name = el('span', 'ov-legend-name');
            add(name, el('strong', '', pool.name + (pool.disabled ? ' (disabled)' : '')), el('code', '', pool.cidr));
            add(row, d, name, el('span', 'ov-legend-num', C.count(pool.used) + ' / ' + C.count(pool.capacity)), el('span', 'ov-legend-pct ' + tone, C.percent(fraction) + ' full'), K.meter(fraction, tone));
            item.appendChild(row);
            legend.appendChild(item);
        });
        if (model.pools.length > 6) legend.appendChild(el('li', 'faint small', 'and ' + (model.pools.length - 6) + ' more pools'));
        return { rings: wrap, legend: legend };
    }

    function drawHero(model) {
        var hero = $('hero');
        hero.textContent = '';
        hero.className = 'ov-hero';
        var v = verdict(model);
        hero.classList.add(v.tone);

        var main = el('div', 'ov-hero-main');
        var eyebrow = el('div', 'ov-eyebrow');
        add(
            eyebrow,
            K.logo(),
            el('span', '', (model.variant === 'CalicoEnterprise' ? 'Calico Enterprise' : 'Calico') + (model.version ? ' ' + model.version : '')),
            el('span', 'faint', '· ' + state.ctx.contextName + (model.namespace ? ' · ' + model.namespace : '')),
        );
        if (model.componentsKnown) {
            var parts = el('span', 'ov-parts');
            ['node', 'typha', 'controllers', 'apiserver'].forEach(function (id) {
                var comp = model.components[id];
                if (!comp.pods.length) return;
                var tone = comp.ready === comp.pods.length ? 'ok' : comp.ready ? 'warn' : 'error';
                var part = K.button('', 'ov-part', null, function () {
                    openView(comp.view);
                });
                part.title = comp.label + ': ' + comp.ready + ' of ' + comp.pods.length + ' ready';
                add(part, K.sdot(tone), el('span', '', comp.label + (comp.pods.length > 1 ? ' ' + comp.ready + '/' + comp.pods.length : '')));
                parts.appendChild(part);
            });
            eyebrow.appendChild(parts);
        }
        main.appendChild(eyebrow);

        var head = el('h1', 'ov-verdict ' + v.tone);
        add(head, K.icon(v.icon), el('span', '', v.text));
        main.appendChild(head);
        main.appendChild(story(model));

        var cta = el('div', 'ov-cta');
        add(
            cta,
            K.button('Open the policy board', 'primary', 'lanes', function () {
                openView('policies');
            }),
            K.button('IP address management', 'ghost', 'grid', function () {
                openView('ipam');
            }),
            K.button('Routing', 'ghost', 'mesh', function () {
                openView('routing');
            }),
            model.flows.whisker || model.flows.goldmane || model.served.whiskers
                ? K.button('Flow logs', 'ghost', 'flows', function () {
                      openView('flows');
                  })
                : null,
        );
        main.appendChild(cta);
        hero.appendChild(main);

        if (model.pools.length) {
            var o = orbit(model);
            var side = el('div', 'ov-hero-side');
            add(side, o.rings, o.legend);
            hero.appendChild(side);
        }
    }

    // ----- the dataplane board -----------------------------------------------------

    function feature(label, iconName, tone, value, sub, opts) {
        opts = opts || {};
        var tile = el('div', 'feat ' + tone);
        var top = el('div', 'feat-top');
        var badge = el('span', 'feat-icon');
        badge.appendChild(K.icon(iconName));
        add(top, badge, el('span', 'feat-label', label), el('span', 'feat-state' + (opts.noSwitch ? ' none' : '')));
        tile.appendChild(top);
        tile.appendChild(el('div', 'feat-value', value));
        var s = el('div', 'feat-sub' + (opts.unknown ? ' unknown' : ''), sub);
        s.title = opts.title || sub;
        tile.appendChild(s);
        if (opts.title) tile.title = opts.title;
        return tile;
    }

    function features(model) {
        var list = [];
        var dp = model.dataplane;
        var dpSub = dp.known ? 'set in ' + dp.source : 'no configuration found — assumed';
        if (dp.auto && dp.id === 'iptables') dpSub = 'nftables instead if kube-proxy runs in nftables mode';
        list.push(feature('Dataplane', dp.id === 'bpf' ? 'bolt' : 'chip', dp.known ? 'info' : 'off', dp.label, dpSub, { noSwitch: true, unknown: !dp.known }));

        var pools = model.pools.filter(function (p) {
            return !p.disabled;
        });
        var encaps = encapSummary(model);
        var tunnels = encaps.filter(function (e) {
            return e.id !== 'none';
        });
        var encapValue = tunnels.length
            ? tunnels
                  .map(function (e) {
                      return e.label;
                  })
                  .join(' + ') + (tunnels.length === 1 && tunnels[0].cross ? ' · CrossSubnet' : '')
            : encaps.length
              ? 'None (native)'
              : '—';
        var encapSub = pools
            .map(function (p) {
                return p.name + ': ' + (p.encap.id === 'none' ? 'none' : p.encap.text);
            })
            .join(' · ');
        list.push(feature('Encapsulation', 'tunnel', tunnels.length ? 'on' : 'off', encapValue, encapSub || 'no pool', { title: encapSub }));

        var bgp = model.bgp;
        var bgpValue;
        var bgpTone;
        if (bgp.enabled === false) {
            bgpValue = 'Off';
            bgpTone = 'off';
        } else if (bgp.enabled === null && !bgp.config && !model.peers.length) {
            bgpValue = 'Unknown';
            bgpTone = 'off';
        } else {
            bgpValue = bgp.mesh ? 'Full mesh' : model.routeReflectors.length ? 'Route reflectors' : model.peers.length ? 'Peers only' : 'No peering';
            bgpTone = !bgp.mesh && !model.peers.length ? 'warn' : 'on';
        }
        var down = model.sessions.filter(function (s) {
            return !s.up;
        }).length;
        if (down && bgpTone === 'on') bgpTone = 'error';
        var bgpSub = bgp.enabled === false ? 'routes come from the tunnels, not BGP' : 'AS ' + bgp.asn + ' · ' + plural(model.peers.length, 'peer') + (down ? ' · ' + down + ' down' : '');
        list.push(feature('BGP', 'mesh', bgpTone, bgpValue, bgpSub, { unknown: bgpValue === 'Unknown' }));

        var wg = model.felix.wireguard || model.felix.wireguardV6;
        var keyed = model.nodes.filter(function (n) {
            return n.wgKey;
        }).length;
        list.push(
            feature(
                'WireGuard',
                'lock',
                wg ? (keyed < model.nodes.length && model.nodes.length ? 'warn' : 'on') : 'off',
                wg ? 'On' + (model.felix.wireguard && model.felix.wireguardV6 ? ' (v4 + v6)' : model.felix.wireguardV6 ? ' (IPv6)' : ' (IPv4)') : 'Off',
                wg ? keyed + ' of ' + plural(model.nodes.length, 'node') + ' have a key' : 'pod traffic between nodes is not encrypted',
            ),
        );

        var nat = pools.filter(function (p) {
            return p.nat;
        }).length;
        list.push(feature('NAT outgoing', 'nat', nat ? 'on' : 'off', !pools.length ? '—' : nat === pools.length ? 'On' : nat ? 'Partly' : 'Off', nat + ' of ' + plural(pools.length, 'pool') + ' masquerade'));

        var v4 = pools.some(function (p) {
            return p.v === 4;
        });
        var v6 = pools.some(function (p) {
            return p.v === 6;
        });
        list.push(feature('IP families', 'dual', 'info', v4 && v6 ? 'IPv4 + IPv6' : v6 ? 'IPv6' : v4 ? 'IPv4' : '—', v4 && v6 ? 'dual-stack pods' : 'single-stack pods', { noSwitch: true }));

        var ty = model.components.typha;
        list.push(
            feature(
                'Typha',
                'fan',
                !ty.pods.length ? 'off' : ty.ready === ty.pods.length ? 'on' : ty.ready ? 'warn' : 'error',
                ty.pods.length ? ty.ready + ' / ' + ty.pods.length + ' ready' : 'Not deployed',
                ty.pods.length ? 'fans datastore updates out to calico-node' : 'calico-node watches the API server itself',
            ),
        );

        var api = model.components.apiserver;
        list.push(
            feature(
                'Calico API server',
                'api',
                !api.pods.length ? (model.apiServer.object ? 'warn' : 'off') : api.ready === api.pods.length ? 'on' : 'error',
                api.pods.length ? (api.ready === api.pods.length ? 'Running' : api.ready + ' / ' + api.pods.length + ' ready') : model.apiServer.object ? 'No pods' : 'Not installed',
                api.pods.length ? 'serves projectcalico.org/v3' : 'kubectl cannot manage projectcalico.org/v3',
            ),
        );

        var flows = model.flows;
        var fl = flows.whisker && flows.goldmane ? 'Whisker + Goldmane' : flows.goldmane ? 'Goldmane' : flows.whisker ? 'Whisker' : model.felix.flowLogs ? 'Collector set' : 'Off';
        var whiskerStatus = model.tigera.filter(function (s) {
            return s.name === 'whisker' || s.name === 'goldmane';
        });
        var flTone = fl === 'Off' ? 'off' : whiskerStatus.some(function (s) {
            return s.tone === 'error';
        })
            ? 'warn'
            : 'on';
        list.push(feature('Flow logs', 'flows', flTone, fl, fl === 'Off' ? (flows.served ? 'no Whisker or Goldmane' : 'needs Calico 3.30+') : model.felix.flowLogs || 'observability UI'));

        var ipamCfg = model.ipamConfig && model.ipamConfig.spec ? model.ipamConfig.spec : {};
        list.push(
            feature(
                'IPAM',
                'grid',
                'info',
                model.blocks.length + ' blocks',
                'strict affinity ' + (ipamCfg.strictAffinity ? 'on' : 'off') + ' · ' + (ipamCfg.maxBlocksPerHost ? 'max ' + ipamCfg.maxBlocksPerHost + ' per node' : 'no block limit'),
                { noSwitch: true },
            ),
        );

        list.push(feature('MTU', 'ruler', 'info', model.mtu ? String(model.mtu) : 'Auto', model.mtu ? (model.installation ? 'reported by the operator' : 'set in FelixConfiguration') : 'auto-detected by calico-node', { noSwitch: true, unknown: !model.mtu }));

        list.push(
            feature(
                'Install',
                'tag',
                'info',
                model.variant === 'CalicoEnterprise' ? 'Calico Enterprise' : 'Calico' + (model.version ? ' ' + C.shortVersion(model.version) : ''),
                model.operator ? 'managed by the Tigera operator' : model.componentsKnown ? 'installed from manifests' : 'installer not detected',
                { noSwitch: true },
            ),
        );
        return list;
    }

    function drawFeatures(model) {
        var box = $('features');
        box.textContent = '';
        box.hidden = false;
        var head = el('div', 'ov-section-head');
        add(head, K.icon('chip'), el('h2', '', 'How the network is built'), el('span', 'card-sub', 'From the operator’s Installation, FelixConfiguration, BGPConfiguration and the IP pools. Grey means off or not installed.'));
        box.appendChild(head);
        var grid = el('div', 'ov-features');
        features(model).forEach(function (t) {
            grid.appendChild(t);
        });
        box.appendChild(grid);

        if (model.tigera.length) {
            var strip = el('div', 'ov-tigera');
            var label = el('span', 'ov-tigera-label');
            add(label, K.icon('logo'), 'Operator status');
            strip.appendChild(label);
            model.tigera.forEach(function (s) {
                var pill = K.button('', 'tpill ' + s.tone, null, function () {
                    open({ kind: C.KINDS.tigeraStatus, namespace: '', name: s.name });
                });
                add(pill, K.sdot(s.tone), el('span', '', s.name), el('span', 'tpill-state', s.state));
                if (s.message && s.tone !== 'ok') pill.appendChild(el('span', 'tpill-msg', s.message));
                pill.title = s.name + ': ' + s.state + (s.message ? ' — ' + s.message : '');
                strip.appendChild(pill);
            });
            box.appendChild(strip);
        }
    }

    // ----- the path --------------------------------------------------------------

    function stage(tone, iconName, label, big, small, onClick) {
        var node = K.button('', 'ov-stage ' + tone, null, onClick);
        var badge = el('span', 'ov-stage-icon');
        badge.appendChild(K.icon(iconName));
        add(node, badge, el('span', 'ov-stage-label', label), el('span', 'ov-stage-big', big), el('span', 'ov-stage-small', small));
        node.title = label + ': ' + big + ' — ' + small;
        return node;
    }

    function link(tone) {
        var node = el('div', 'ov-link ' + tone);
        var s = K.svg('svg', { viewBox: '0 0 40 12', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
        s.appendChild(K.svg('line', { x1: 0, y1: 6, x2: 40, y2: 6, class: 'ov-link-track' }));
        s.appendChild(K.svg('line', { x1: 0, y1: 6, x2: 40, y2: 6, class: 'ov-link-flow' }));
        node.appendChild(s);
        return node;
    }

    function drawPath(model) {
        var box = $('path');
        box.textContent = '';
        box.hidden = false;
        var r = readyNodes(model);
        var t = totals(model);
        var kc = model.components.controllers;
        var fullest = 0;
        model.pools.forEach(function (p) {
            fullest = Math.max(fullest, C.share(p.used, p.capacity));
        });
        var borrowed = 0;
        model.pools.forEach(function (p) {
            borrowed += p.borrowed;
        });
        var bad = model.policies.filter(function (p) {
            return p.error || p.ruleErrors;
        }).length;
        var idle = model.policies.filter(function (p) {
            return !p.staged && !p.error && !p.matches.length && !p.global;
        }).length;

        var steps = [
            model.componentsKnown
                ? stage(r.ready < r.withPod ? 'error' : r.withPod < r.total ? 'warn' : 'ok', 'node', 'calico-node', r.ready + ' / ' + r.total, r.ready < r.withPod ? r.withPod - r.ready + ' not ready' : r.withPod < r.total ? r.total - r.withPod + ' without a pod' : 'ready on every node', function () {
                      openView('calico-node');
                  })
                : stage('muted', 'node', 'calico-node', '—', 'no calico-node pods found', function () {
                      openView('calico-node');
                  }),
            kc.pods.length
                ? stage(kc.ready ? 'ok' : 'error', 'spark', 'kube-controllers', kc.ready ? 'Ready' : 'Not ready', kc.ready ? 'cleans up IPAM' : 'leaked addresses pile up', function () {
                      openView('kube-controllers');
                  })
                : stage('muted', 'spark', 'kube-controllers', '—', 'no pod found', function () {
                      openView('kube-controllers');
                  }),
            stage(!model.pools.length ? 'error' : fullest >= 0.95 ? 'error' : fullest >= 0.8 ? 'warn' : 'ok', 'pool', 'IP pools', String(model.pools.length), model.pools.length ? 'fullest is ' + C.percent(fullest) : 'none — pods get no address', function () {
                openView('ipam');
            }),
            stage(borrowed || model.orphanBlocks.length ? 'warn' : 'ok', 'grid', 'IPAM blocks', String(model.blocks.length), borrowed ? borrowed + ' borrowed addresses' : model.orphanBlocks.length ? model.orphanBlocks.length + ' outside any pool' : 'on ' + plural(model.nodes.filter(function (n) {
                return n.blocks.length;
            }).length, 'node'), function () {
                openView('ipam');
            }),
            stage(bad ? 'error' : idle ? 'warn' : t.policies ? 'ok' : 'muted', 'shield', 'Policies', String(t.policies), bad ? bad + ' do not parse' : idle ? idle + ' apply to nothing' : 'in ' + plural(t.tiersInUse, 'tier') + (t.staged ? ' · ' + t.staged + ' staged' : ''), function () {
                openView('policies');
            }),
            stage(!model.weps.length ? 'muted' : t.open.length ? 'warn' : 'ok', 'shieldCheck', 'Protected', C.percent(model.coverage.fraction), model.coverage.covered + ' of ' + plural(model.coverage.total, 'workload'), function () {
                openView('policies');
            }),
        ];
        steps.forEach(function (s, i) {
            if (i > 0) {
                var tone = s.classList.contains('error') ? 'error' : s.classList.contains('warn') ? 'warn' : s.classList.contains('muted') ? 'muted' : 'ok';
                box.appendChild(link(tone));
            }
            box.appendChild(s);
        });
    }

    // ----- nodes -----------------------------------------------------------------

    function nodeTile(model, n) {
        var sessions = model.sessions.filter(function (s) {
            return s.node === n;
        });
        var down = sessions.filter(function (s) {
            return !s.up;
        }).length;
        var tone = !n.calico ? (model.componentsKnown ? 'warn' : 'muted') : !n.calicoReady ? 'error' : !n.ready ? 'warn' : down ? 'warn' : 'ok';
        var tile = K.button('', 'ntile ' + tone, null, function () {
            open({ kind: C.KINDS.nodes, namespace: '', name: n.name });
        });
        var head = el('div', 'ntile-head');
        add(head, K.icon('node'), el('span', 'ntile-name', n.name), el('span', 'ntile-state', !n.calico ? (model.componentsKnown ? 'no calico-node' : 'unknown') : !n.calicoReady ? 'not ready' : !n.ready ? 'node not ready' : down ? down + ' BGP down' : 'ready'));
        tile.appendChild(head);
        var nums = el('div', 'ntile-nums');
        add(nums, add(el('span'), b(String(n.pods)), ' pods'), add(el('span'), b(String(n.blocks.length)), ' blocks'), n.borrowed ? add(el('span', 'warn-text'), b(String(n.borrowed)), ' borrowed') : null);
        tile.appendChild(nums);

        // Block usage: one segment per block, filled by how much is used.
        var bar = el('div', 'ntile-bar');
        var capacity = n.capacity || 1;
        n.blocks.slice(0, 24).forEach(function (blk) {
            var seg = el('i');
            seg.style.width = (blk.size / capacity) * 100 + '%';
            seg.style.opacity = String(0.25 + 0.75 * blk.fraction);
            seg.style.background = model.poolColors[blk.pool ? blk.pool.name : ''] || 'var(--k-faint)';
            bar.appendChild(seg);
        });
        tile.appendChild(bar);

        var badges = el('div', 'ntile-badges');
        if (n.vxlan || n.vxlan6) badges.appendChild(K.chip('VXLAN', 'vxlan', null, 'VXLAN tunnel ' + (n.vxlan || n.vxlan6)));
        if (n.ipip) badges.appendChild(K.chip('IPIP', 'ipip', null, 'IPIP tunnel ' + n.ipip));
        if (n.wgKey) badges.appendChild(K.chip('WireGuard', 'wg', null, 'WireGuard ' + (n.wg || '')));
        if (n.rr) badges.appendChild(K.chip('RR', 'warn', 'star', 'Route reflector, cluster ID ' + n.rr));
        if (n.asn) badges.appendChild(K.chip('AS ' + n.asn, 'bgp'));
        if (n.calicoRestarts) badges.appendChild(K.chip(n.calicoRestarts + ' restarts', n.calicoReady ? 'muted' : 'error'));
        if (n.unschedulable) badges.appendChild(K.chip('cordoned', 'muted'));
        tile.appendChild(badges);
        var addr = n.ipv4 || n.internalIPs[0] || '';
        tile.title = n.name + (addr ? ' · ' + C.stripMask(addr) : '') + ' — ' + head.lastChild.textContent;
        return tile;
    }

    function drawNodes(model) {
        var box = $('nodes');
        box.textContent = '';
        box.hidden = !model.nodes.length;
        if (box.hidden) return;
        var head = el('div', 'ov-section-head');
        var r = readyNodes(model);
        add(head, K.icon('node'), el('h2', '', 'Nodes'), el('span', 'count ' + (r.ready < r.withPod ? 'error' : 'muted'), r.ready + ' / ' + r.total), el('span', 'card-sub', 'calico-node on each node, its pods, its IPAM blocks (one bar segment each, filled by use) and its tunnels.'));
        box.appendChild(head);
        var grid = el('div', 'ov-nodes');
        // The ones in trouble first.
        var order = model.nodes.slice().sort(function (a, b) {
            var ra = a.calico && !a.calicoReady ? 0 : !a.calico ? 1 : 2;
            var rb = b.calico && !b.calicoReady ? 0 : !b.calico ? 1 : 2;
            return ra - rb || (a.name < b.name ? -1 : 1);
        });
        var shown = order.length > MAX_NODES + 1 ? order.slice(0, MAX_NODES) : order;
        shown.forEach(function (n) {
            grid.appendChild(nodeTile(model, n));
        });
        if (shown.length < order.length) {
            grid.appendChild(
                K.button('+ ' + (order.length - shown.length) + ' more on the routing page', 'ov-more', null, function () {
                    openView('routing');
                }),
            );
        }
        box.appendChild(grid);
    }

    // ----- attention and activity -------------------------------------------------

    var GROUPS = { components: ['Components', 'node'], ipam: ['Addresses', 'grid'], policy: ['Policy', 'shield'], routing: ['Routing', 'mesh'] };

    function drawAttention(model) {
        var box = $('attention');
        box.textContent = '';
        var found = model.findings;
        var serious = attention(model);
        box.className = 'ov-card' + (serious.length ? (serious.some(function (f) {
            return f.tone === 'error';
        })
            ? ' has-error'
            : '') : ' clear');
        var head = el('div', 'ov-card-head');
        add(head, K.icon(serious.length ? 'alert' : 'check'), el('h2', '', serious.length ? 'Needs attention' : 'All clear'));
        if (serious.length) head.appendChild(el('span', 'count ' + (box.classList.contains('has-error') ? 'error' : ''), String(serious.length)));
        box.appendChild(head);
        if (!found.length) {
            box.appendChild(el('p', 'ov-quiet', 'calico-node is ready everywhere, every pool has room, every policy parses and selects something, and every BGP session calico-node reports is up.'));
            return;
        }
        if (!serious.length) box.appendChild(el('p', 'ov-quiet', 'Nothing is wrong. Worth knowing:'));
        var rank = { error: 0, warn: 1, info: 2 };
        var worst = {};
        found.forEach(function (f, i) {
            if (worst[f.group] === undefined) worst[f.group] = rank[f.tone] * 1000 + i;
        });
        var ordered = found.slice().sort(function (a, b) {
            return worst[a.group] - worst[b.group] || rank[a.tone] - rank[b.tone];
        });
        var shown = 0;
        var lastGroup = '';
        var list = null;
        ordered.forEach(function (f) {
            if (shown >= MAX_ISSUES) return;
            shown++;
            if (f.group !== lastGroup) {
                lastGroup = f.group;
                var g = GROUPS[f.group] || ['Other', 'info'];
                var title = el('div', 'ov-group-title');
                add(title, K.icon(g[1]), g[0]);
                box.appendChild(title);
                list = el('ul', 'issues');
                box.appendChild(list);
            }
            var item = el('li', 'issue ' + f.tone);
            var body = el('div', 'issue-body');
            body.appendChild(el('div', 'issue-text', f.text));
            item.appendChild(body);
            if (f.ref) {
                item.appendChild(
                    K.iconButton('open', 'Open', function () {
                        open(f.ref);
                    }),
                );
            } else if (f.view) {
                item.appendChild(
                    K.iconButton('arrow', 'Go there', function () {
                        openView(f.view);
                    }),
                );
            }
            list.appendChild(item);
        });
        if (found.length > shown) box.appendChild(el('p', 'ov-quiet', 'and ' + (found.length - shown) + ' more on the pages below.'));
    }

    var RELEVANT = /calico|felix|bird|typha|ipam|tigera|goldmane|whisker|wireguard|vxlan/i;

    function loadEvents(model) {
        return sdk
            .list({ kind: C.KINDS.events, namespace: '' })
            .catch(function () {
                return [];
            })
            .then(function (items) {
                var mine = {};
                [model.namespace, 'calico-system', 'calico-apiserver', 'tigera-operator'].forEach(function (ns) {
                    if (ns) mine[ns] = true;
                });
                var out = [];
                items.forEach(function (ev) {
                    var target = ev.involvedObject || ev.regarding || {};
                    var ns = target.namespace || ev.metadata.namespace || '';
                    var text = [ev.reason, ev.message, ev.note, (ev.source && ev.source.component) || '', ev.reportingController || '', target.name].join(' ');
                    var about = mine[ns] || RELEVANT.test(text);
                    if (!about) return;
                    // Other namespaces' routine events are not Calico's news.
                    if (!mine[ns] && ev.type !== 'Warning') return;
                    out.push({
                        uid: ev.metadata.uid,
                        when: ev.lastTimestamp || ev.eventTime || (ev.series && ev.series.lastObservedTime) || ev.metadata.creationTimestamp || '',
                        type: ev.type || 'Normal',
                        reason: ev.reason || '',
                        message: ev.message || ev.note || '',
                        count: (ev.series && ev.series.count) || ev.count || 1,
                        kind: target.kind || '',
                        namespace: target.namespace || '',
                        name: target.name || '',
                    });
                });
                return out
                    .sort(function (a, b) {
                        return a.when < b.when ? 1 : a.when > b.when ? -1 : 0;
                    })
                    .slice(0, 12);
            });
    }

    var KIND_REFS = { Pod: C.KINDS.pods, Node: C.KINDS.nodes, Namespace: C.KINDS.namespaces, Service: C.KINDS.services };

    function drawActivity() {
        var box = $('activity');
        box.textContent = '';
        var head = el('div', 'ov-card-head');
        add(head, K.icon('activity'), el('h2', '', 'Recent activity'));
        box.appendChild(head);
        if (state.events === null) {
            box.appendChild(el('p', 'ov-quiet', 'Reading events…'));
            return;
        }
        if (!state.events.length) {
            box.appendChild(el('p', 'ov-quiet', 'Nothing from Calico lately. Kubernetes keeps events for about an hour, so a quiet cluster reads as an empty list.'));
            return;
        }
        var list = el('ol', 'ov-timeline');
        state.events.forEach(function (ev) {
            var warn = ev.type === 'Warning';
            var item = el('li', 'ov-event' + (warn ? ' warn' : ''));
            var mark = el('span', 'ov-event-mark');
            mark.appendChild(K.icon(warn ? 'alert' : 'activity'));
            item.appendChild(mark);
            var body = el('div', 'ov-event-body');
            var line = el('div', 'ov-event-line');
            var appKind = KIND_REFS[ev.kind];
            var who = (ev.namespace && ev.kind !== 'Node' ? ev.namespace + '/' : '') + ev.name;
            add(
                line,
                el('span', 'reason', ev.reason || ev.type),
                ' · ',
                appKind
                    ? K.link(who, function () {
                          open({ kind: appKind, namespace: ev.namespace, name: ev.name });
                      })
                    : el('span', '', ev.kind + ' ' + who),
            );
            body.appendChild(line);
            var msg = el('div', 'ov-event-msg', ev.message);
            msg.title = ev.message;
            body.appendChild(msg);
            body.appendChild(el('div', 'ov-event-meta', K.ago(ev.when) + (ev.count > 1 ? ' · ' + ev.count + '×' : '') + (ev.kind ? ' · ' + ev.kind : '')));
            item.appendChild(body);
            list.appendChild(item);
        });
        box.appendChild(list);
    }

    // ----- history -----------------------------------------------------------------

    function drawHistory() {
        var box = $('history');
        box.textContent = '';
        var panel = state.panel;
        box.hidden = !panel || !panel.attached;
        if (box.hidden) return;
        var head = el('div', 'ov-section-head');
        add(head, K.icon('chart'), el('h2', '', 'Over the last ' + Math.round(HISTORY_MINUTES / 60) + ' hours'));
        box.appendChild(head);
        if (!panel.source.available) {
            box.appendChild(el('p', 'ov-quiet', 'No Prometheus was found in this cluster, so there is no history to draw — everything above comes from the API server. ' + (panel.source.error ? '(' + panel.source.error + ') ' : '') + 'Set one in the cluster settings panel if it lives somewhere the app did not look.'));
            return;
        }
        var colors = state.model ? state.model.poolColors : {};
        var row = el('div', 'ov-chart-row');
        panel.charts.forEach(function (chart) {
            row.appendChild(
                K.sparkChart(chart, function (name, i) {
                    return colors[name] || K.seriesColor(i);
                }),
            );
        });
        box.appendChild(row);
        if (panel.source.describe) box.appendChild(el('p', 'ov-source', 'From ' + panel.source.describe + '. Needs Felix and kube-controllers metrics scraped.'));
    }

    // ----- the foot ------------------------------------------------------------------

    var DESTINATIONS = [
        { id: 'policies', label: 'Policy board', icon: 'lanes' },
        { id: 'ipam', label: 'IP address management', icon: 'grid' },
        { id: 'routing', label: 'Routing & BGP', icon: 'mesh' },
        { id: 'ip-pools', label: 'IP pools', icon: 'pool' },
        { id: 'network-policies', label: 'Network policies', icon: 'shield' },
        { id: 'global-network-policies', label: 'Global policies', icon: 'globe' },
        { id: 'k8s-network-policies', label: 'Kubernetes policies', icon: 'shield' },
        { id: 'tiers', label: 'Tiers', icon: 'tier' },
        { id: 'bgp-peers', label: 'BGP peers', icon: 'cloud' },
        { id: 'felix-configuration', label: 'Felix configuration', icon: 'chip' },
        { id: 'calico-node', label: 'calico-node pods', icon: 'node' },
    ];

    function drawFoot() {
        var box = $('foot');
        box.textContent = '';
        box.hidden = false;
        var go = el('div', 'ov-go');
        DESTINATIONS.forEach(function (d) {
            go.appendChild(
                K.button(d.label, 'ov-go-tile', d.icon, function () {
                    openView(d.id);
                }),
            );
        });
        box.appendChild(go);
        if (state.summary && state.summary.requirements.length) {
            var reqs = el('div', 'ov-reqs');
            reqs.appendChild(el('span', 'ov-reqs-label', 'This cluster serves'));
            state.summary.requirements.forEach(function (r) {
                var tone = r.error ? 'warn' : r.served ? 'ok' : r.optional ? 'muted' : 'error';
                reqs.appendChild(K.chip(r.label, tone, r.error ? 'alert' : r.served ? 'check' : 'close', r.error || r.kind));
            });
            box.appendChild(reqs);
        }
        add(box, K.about(sdk, state.ctx && state.ctx.plugin, fail));
    }

    // ----- not here, or not reachable ---------------------------------------------------

    function drawAbsent(summary, model) {
        var hero = $('hero');
        hero.textContent = '';
        hero.className = 'ov-hero absent';
        ['features', 'path', 'nodes', 'columns', 'history', 'foot'].forEach(function (id) {
            $(id).hidden = true;
        });
        var main = el('div', 'ov-hero-main');
        var art = el('div', 'empty-art');
        art.appendChild(K.icon('logo'));
        main.appendChild(art);
        var unreachable = summary && !summary.checked;
        main.appendChild(el('h1', 'ov-verdict', unreachable ? 'This cluster did not answer' : 'Calico is not installed in ' + state.ctx.contextName));
        main.appendChild(
            el(
                'p',
                'ov-story',
                unreachable
                    ? 'Whether Calico is here could not be checked, which is not the same as it being absent. ' + (summary.error || '')
                    : 'This cluster does not serve the crd.projectcalico.org kinds every Calico install has, so its pod network and network policy come from another CNI — or from nothing at all.',
            ),
        );
        if (summary && summary.requirements.length) main.appendChild(K.requirementList(summary.requirements));
        else if (model && model.missing) main.appendChild(el('p', 'faint small', model.missing));
        if (!unreachable) {
            var cta = el('div', 'ov-cta');
            cta.appendChild(
                K.button('How to install Calico', 'primary', 'open', function () {
                    sdk.openUrl('https://docs.tigera.io/calico/latest/getting-started/kubernetes/').catch(fail);
                }),
            );
            main.appendChild(cta);
        }
        add(main, K.about(sdk, state.ctx && state.ctx.plugin, fail));
        hero.appendChild(main);
    }

    // ----- putting it together --------------------------------------------------------

    function render() {
        var model = state.model;
        var summary = state.summary;
        if (summary && (!summary.checked || !summary.installed)) {
            drawAbsent(summary, model);
            return;
        }
        if (!model) return;
        if (!model.installed) {
            drawAbsent(summary, model);
            return;
        }
        $('columns').hidden = false;
        drawHero(model);
        drawFeatures(model);
        drawPath(model);
        drawNodes(model);
        drawAttention(model);
        drawActivity();
        drawHistory();
        drawFoot();
    }

    function stamp(model) {
        // Relative times go stale without anything changing.
        return model.sig + '|' + Math.floor(Date.now() / 60000);
    }

    function refreshEvents() {
        if (!state.model || !state.model.installed) return;
        loadEvents(state.model)
            .then(function (events) {
                var changed = JSON.stringify(events) !== JSON.stringify(state.events);
                state.events = events;
                if (changed && !$('columns').hidden) drawActivity();
            })
            .catch(fail);
    }

    sdk.ready()
        .then(function (context) {
            state.ctx = context;
            K.every(
                POLL,
                function () {
                    return C.load(sdk).then(function (model) {
                        clearError();
                        var sig = stamp(model);
                        if (sig === state.sig) return;
                        var first = !state.model;
                        state.model = model;
                        state.sig = sig;
                        render();
                        if (first) refreshEvents();
                    });
                },
                fail,
            );
            K.every(
                SUMMARY_EVERY,
                function () {
                    return sdk.summary().then(function (summary) {
                        var changed = JSON.stringify(summary) !== JSON.stringify(state.summary);
                        state.summary = summary;
                        if (changed) render();
                    });
                },
                fail,
            );
            K.every(
                CHARTS_EVERY,
                function () {
                    if (!sdk.charts) return null;
                    return sdk.charts({ minutes: HISTORY_MINUTES }).then(function (panel) {
                        state.panel = panel;
                        if (state.model && state.model.installed && !(state.summary && !state.summary.installed)) drawHistory();
                    });
                },
                fail,
            );
            setInterval(refreshEvents, EVENTS_EVERY);
        })
        .catch(fail);
})();
