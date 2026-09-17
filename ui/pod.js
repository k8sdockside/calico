// A pod's Calico panel: the addresses it got and the block, pool and node
// they came from, the policies that select it in the order Calico evaluates
// them, and what that means for its traffic -- or that nothing selects it.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var C = window.Calico;
    var K = window.CalicoKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;

    var state = { ctx: null, sig: '', notice: '' };

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

    function verdict(tone, iconName, title, text) {
        var v = el('div', 'panel-verdict ' + tone);
        var body = el('div');
        add(body, el('strong', '', title), el('span', '', text));
        add(v, K.icon(iconName), body);
        return v;
    }

    function addresses(model, pod) {
        var box = el('div', 'ip-rows');
        pod.ips.forEach(function (text) {
            var ip = C.parseIP(text);
            var at = ip ? model.allocations.get(C.ipKey(ip)) : null;
            var row = el('div', 'ip-row');
            var top = el('div', 'ip-top');
            top.appendChild(el('code', 'big-ip', text));
            var tags = el('div', 'ip-tags');
            top.appendChild(tags);
            row.appendChild(top);
            var hops = el('div', 'hops');
            if (!at) {
                var pool = ip ? C.poolOfIP(model, ip) : null;
                tags.appendChild(K.chip(pool ? 'no IPAM block records it' : 'not from Calico IPAM', 'warn', 'alert', pool ? 'Inside pool ' + pool.name : ''));
            } else {
                var b = at.block;
                if (b.pool) {
                    var hp = el('span', 'hop');
                    add(hp, K.icon('pool'), el('span', 'hop-label', 'pool'), K.link(b.pool.name, function () {
                        open({ kind: C.KINDS.pools, namespace: '', name: b.pool.name });
                    }));
                    hops.appendChild(hp);
                    hops.appendChild(K.icon('chevron', 'hop-arrow'));
                }
                var hb = el('span', 'hop');
                add(hb, K.icon('grid'), el('span', 'hop-label', 'block'), K.link(b.cidr, function () {
                    open({ kind: C.KINDS.blocks, namespace: '', name: b.name });
                }));
                hops.appendChild(hb);
                hops.appendChild(K.icon('chevron', 'hop-arrow'));
                var hn = el('span', 'hop');
                add(hn, K.icon('node'), el('span', 'hop-label', b.node ? 'affine to' : 'no affinity'), b.node ? el('span', '', b.node) : null);
                hops.appendChild(hn);
                if (at.borrowed) tags.appendChild(K.chip('borrowed · runs on ' + at.node, 'warn', 'alert', 'The block belongs to ' + b.node + '; routes to this address go via that node first.'));
                if (b.pool && b.pool.encap.id !== 'none') tags.appendChild(K.chip(b.pool.encap.text, b.pool.encap.id));
            }
            row.appendChild(hops);
            box.appendChild(row);
        });
        return box;
    }

    function outcome(model, pod, dir) {
        var t = C.trace(model, pod, dir);
        var cls = t.result.action === 'Allow' ? 'allow' : t.result.action === 'Deny' ? 'deny' : '';
        var box = el('div', 'outcome ' + cls);
        var head = el('div', 'outcome-head');
        add(head, K.icon(dir === 'in' ? 'down' : 'arrow'), dir === 'in' ? 'Inbound' : 'Outbound', K.actionPill(t.result.profile ? 'Allow' : t.result.action, true));
        box.appendChild(head);
        box.appendChild(el('div', 'outcome-body', t.applied ? t.result.text + (t.result.passed ? ' ' + t.result.passed.text : '') : 'No policy applies: everything is allowed.'));
        return box;
    }

    function draw(model, pod) {
        var root = $('root');
        root.textContent = '';

        if (state.notice) {
            var note = el('div', 'notice');
            add(note, K.icon('check'), el('span', '', state.notice));
            root.appendChild(note);
        }

        if (pod.hostNetwork) {
            root.appendChild(verdict('warn', 'info', 'Host network', 'This pod uses the address of ' + (pod.node || 'its node') + '. Calico sees its traffic as the node’s own, so workload policy does not apply to it — host endpoint policy would.'));
            return;
        }
        if (!pod.wep) {
            root.appendChild(verdict('warn', 'info', 'Not running', 'The pod is ' + pod.phase + ', so it no longer has an address or a Calico endpoint.'));
            return;
        }

        var enforced = pod.policies;
        var tiers = {};
        enforced.forEach(function (p) {
            tiers[p.tier] = true;
        });
        var ns = model.namespaceByName[pod.namespace];
        if (!enforced.length) {
            var v = verdict('warn', 'shieldOff', 'No policy selects this pod — all traffic is allowed', 'Calico falls back to the namespace profile, which allows everything in and out.');
            if (state.ctx.write && ns && !ns.pods.some(function (p) {
                return p.policies.length;
            })) {
                var iso = K.button('Isolate ' + pod.namespace, 'small push', 'shieldPlus', function () {
                    K.isolate(sdk, pod.namespace)
                        .then(function (res) {
                            if (!res) return;
                            state.notice = 'Asked to create NetworkPolicy default-deny-ingress in ' + pod.namespace + '.';
                            state.sig = '';
                            tick(true);
                            setTimeout(function () {
                                state.notice = '';
                                state.sig = '';
                            }, 7000);
                        })
                        .catch(fail);
                });
                iso.title = 'Create a Kubernetes NetworkPolicy default-deny-ingress in ' + pod.namespace + ' (you see it first)';
                v.appendChild(iso);
            }
            root.appendChild(v);
        } else {
            root.appendChild(verdict('ok', 'shieldCheck', plural(enforced.length, 'policy', 'policies') + ' in ' + plural(Object.keys(tiers).length, 'tier') + ' select this pod', 'Evaluated in this order; the first rule that matches decides.'));
        }

        if (pod.ips.length) {
            root.appendChild(el('h3', 'mini-title', 'Addresses'));
            root.lastChild.style.margin = '0 0 6px';
            root.appendChild(addresses(model, pod));
        } else {
            plain(root, 'info', 'No address yet.');
        }

        if (enforced.length) {
            var outs = el('div', 'outcomes');
            add(outs, outcome(model, pod, 'in'), outcome(model, pod, 'out'));
            root.appendChild(outs);

            root.appendChild(el('h3', 'mini-title', 'Policies, in evaluation order'));
            root.lastChild.style.margin = '14px 0 6px';
            model.tiers.forEach(function (tier) {
                var mine = tier.policies.filter(function (p) {
                    return enforced.indexOf(p) >= 0;
                });
                if (!mine.length) return;
                var block = el('div', 'tier-block');
                var head = el('div', 'tier-block-head');
                add(head, K.icon('tier'), el('strong', '', tier.name), el('span', '', '· order ' + K.orderText(tier.order) + ' · ends in ' + tier.defaultAction));
                block.appendChild(head);
                mine.forEach(function (p) {
                    block.appendChild(
                        K.policyLine(p, function () {
                            open(p.ref);
                        }),
                    );
                });
                root.appendChild(block);
            });
        }
        if (pod.staged.length) {
            root.appendChild(el('h3', 'mini-title', 'Staged — previewed, not enforced'));
            root.lastChild.style.margin = '14px 0 6px';
            var sb = el('div', 'tier-block');
            pod.staged.forEach(function (p) {
                sb.appendChild(
                    K.policyLine(
                        p,
                        function () {
                            open(p.ref);
                        },
                        { tier: true },
                    ),
                );
            });
            root.appendChild(sb);
        }

        var foot = el('div', 'd-tools');
        foot.style.margin = '12px 0 0';
        foot.style.justifyContent = 'flex-start';
        foot.appendChild(
            K.button('Policy board', 'ghost small', 'lanes', function () {
                sdk.openView('policies').catch(fail);
            }),
        );
        if (pod.allocations.length) {
            foot.appendChild(
                K.button('IP address management', 'ghost small', 'grid', function () {
                    sdk.openView('ipam').catch(fail);
                }),
            );
        }
        root.appendChild(foot);
    }

    function tick(once) {
        C.load(sdk)
            .then(function (model) {
                $('error').hidden = true;
                var ref = state.ctx.object;
                var root = $('root');
                if (!model.installed) {
                    root.textContent = '';
                    plain(root, 'info', 'Calico is not installed in ' + state.ctx.contextName + ', so it does not network or police this pod.');
                    return;
                }
                var pod = model.podByKey[ref.namespace + '/' + ref.name];
                if (!pod) {
                    root.textContent = '';
                    plain(root, 'info', 'This pod could not be read.');
                    return;
                }
                if (model.sig === state.sig) return;
                state.sig = model.sig;
                draw(model, pod);
            })
            .catch(fail)
            .then(function () {
                if (!once) setTimeout(tick, POLL);
            });
    }

    sdk.ready()
        .then(function (context) {
            state.ctx = context;
            if (!context.object) {
                fail(new Error('This page is a panel, drawn for one pod.'));
                return;
            }
            tick();
        })
        .catch(fail);
})();
