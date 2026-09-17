// The policy board: every tier as a swimlane in the order Calico evaluates
// them, each lane's policies in order along a ruler and ending in what the
// tier does with traffic nothing decided. A policy opens in a drawer, rule by
// rule. "Trace" follows one workload's traffic through the tiers and says
// where evaluation ends. Namespaces nothing protects get an Isolate button.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var C = window.Calico;
    var K = window.CalicoKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;
    var MAX_CARDS = 160;
    var MAX_WORKLOADS = 60;

    var KIND_FILTERS = [
        { id: 'np', label: 'Calico', kinds: ['np', 'snp'], badge: 'NP' },
        { id: 'gnp', label: 'Global', kinds: ['gnp', 'sgnp'], badge: 'GNP' },
        { id: 'knp', label: 'Kubernetes', kinds: ['knp', 'sknp'], badge: 'K8s' },
    ];

    var state = {
        ctx: null,
        model: null,
        sig: '',
        error: '',
        mode: 'board',
        ns: '',
        query: '',
        hide: {},
        staged: true,
        selected: '',
        pod: '',
        traceNs: '',
        width: 0,
        notice: '',
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

    // ----- the hash --------------------------------------------------------------

    function readHash() {
        var h = K.readHash();
        if (h.mode === 'trace') state.mode = 'trace';
        if (h.ns) state.ns = h.ns;
        if (h.hide) {
            h.hide.split(',').forEach(function (k) {
                state.hide[k] = true;
            });
        }
        if (h.staged === '0') state.staged = false;
        if (h.sel) state.selected = h.sel;
        if (h.pod) state.pod = h.pod;
        if (Number(h.width) > 0) state.width = Number(h.width);
    }

    function writeHash() {
        K.writeHash({
            mode: state.mode === 'trace' ? 'trace' : '',
            ns: state.ns,
            hide: Object.keys(state.hide)
                .filter(function (k) {
                    return state.hide[k];
                })
                .join(','),
            staged: state.staged ? '' : '0',
            sel: state.selected,
            pod: state.mode === 'trace' ? state.pod : '',
            width: state.width,
        });
    }

    // ----- filtering ---------------------------------------------------------------

    function appliesToNamespace(model, pol, ns) {
        if (!ns) return true;
        if (!pol.global) return pol.namespace === ns;
        var entry = model.namespaceByName[ns];
        if (entry && entry.pods.length) return pol.namespaces.indexOf(ns) >= 0;
        if (!pol.namespaceSelector) return true;
        var sel = window.CalicoSelector.parse(pol.namespaceSelector);
        return sel.ev(entry ? entry.selectorLabels : {});
    }

    function kindShown(pol) {
        for (var i = 0; i < KIND_FILTERS.length; i++) {
            if (KIND_FILTERS[i].kinds.indexOf(pol.kind) >= 0) return !state.hide[KIND_FILTERS[i].id];
        }
        return true;
    }

    function matchesQuery(pol) {
        var q = state.query.trim().toLowerCase();
        if (!q) return true;
        return [pol.name, pol.namespace || 'global', pol.selectorText, pol.tier, pol.info.label]
            .join(' ')
            .toLowerCase()
            .indexOf(q) >= 0;
    }

    function visible(model, pol) {
        return (state.staged || !pol.staged) && kindShown(pol) && appliesToNamespace(model, pol, state.ns) && matchesQuery(pol);
    }

    // ----- the bar -------------------------------------------------------------------

    function drawBar(model) {
        var bar = $('bar');
        if (bar.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
        bar.textContent = '';

        var pick = el('label', 'ns-pick');
        pick.appendChild(K.icon('ns'));
        var select = el('select', 'picker');
        select.setAttribute('aria-label', 'Namespace');
        var all = el('option', '', 'All namespaces');
        all.value = '';
        select.appendChild(all);
        var open = {};
        model.openNamespaces.forEach(function (ns) {
            open[ns.name] = true;
        });
        model.namespaces
            .slice()
            .sort(function (a, b) {
                return a.name < b.name ? -1 : 1;
            })
            .forEach(function (ns) {
                var o = el('option', '', ns.name + (open[ns.name] ? '  — no policy' : ''));
                o.value = ns.name;
                if (ns.name === state.ns) o.selected = true;
                select.appendChild(o);
            });
        select.addEventListener('change', function () {
            state.ns = select.value;
            writeHash();
            render(true);
        });
        pick.appendChild(select);
        bar.appendChild(pick);

        bar.appendChild(el('span', 'filter-sep'));
        KIND_FILTERS.forEach(function (f) {
            var n = model.policies.filter(function (p) {
                return f.kinds.indexOf(p.kind) >= 0 && (state.staged || !p.staged);
            }).length;
            var on = !state.hide[f.id];
            var chip = K.button('', 'fchip' + (on ? ' on' : ' off'), null, function () {
                state.hide[f.id] = on;
                writeHash();
                render(true);
            });
            chip.setAttribute('aria-pressed', String(on));
            var badge = el('span', 'kbadge k-' + f.id, f.badge);
            add(chip, badge, el('span', '', f.label), el('span', 'fchip-n', String(n)));
            bar.appendChild(chip);
        });
        var stagedCount = model.policies.filter(function (p) {
            return p.staged;
        }).length;
        var st = K.button('', 'fchip' + (state.staged ? ' on' : ' off'), null, function () {
            state.staged = !state.staged;
            writeHash();
            render(true);
        });
        st.setAttribute('aria-pressed', String(state.staged));
        add(st, el('span', 'kbadge k-staged', 'staged'), el('span', '', 'Show staged'), el('span', 'fchip-n', String(stagedCount)));
        bar.appendChild(st);

        var shown = model.policies.filter(function (p) {
            return visible(model, p);
        }).length;
        bar.appendChild(el('span', 'board-count', shown === model.policies.length ? plural(shown, 'policy', 'policies') + ' in ' + plural(model.tiers.length, 'tier') : 'Showing ' + shown + ' of ' + model.policies.length + ' policies'));
    }

    // ----- coverage and open namespaces --------------------------------------------

    function drawCoverage(model) {
        var box = $('coverage');
        box.textContent = '';
        var pods = state.ns ? (model.namespaceByName[state.ns] || { pods: [] }).pods : model.weps;
        var covered = pods.filter(function (p) {
            return p.policies.length > 0;
        }).length;
        var fraction = pods.length ? covered / pods.length : 0;
        var tone = !pods.length ? 'info' : fraction >= 0.9 ? 'ok' : fraction >= 0.5 ? 'warn' : 'error';

        var cov = el('div', 'cov-card');
        cov.appendChild(K.ring(fraction, 64, tone, C.percent(fraction) + ' protected'));
        var nums = el('div');
        add(nums, el('div', 'cov-big', pods.length ? C.percent(fraction) : '—'), el('div', 'cov-small', pods.length ? covered + ' of ' + plural(pods.length, 'workload') + (state.ns ? ' in ' + state.ns : '') + ' selected by a policy' : 'no workloads' + (state.ns ? ' in ' + state.ns : '')));
        var legend = el('div', 'cov-legend');
        var enforced = model.policies.filter(function (p) {
            return !p.staged;
        }).length;
        add(legend, add(el('span'), K.sdot('ok'), enforced + ' enforced'), add(el('span'), K.sdot('muted'), model.policies.length - enforced + ' staged'), add(el('span'), K.icon('tier'), plural(model.tiers.length, 'tier')));
        nums.appendChild(legend);
        cov.appendChild(nums);
        box.appendChild(cov);

        var list = model.openNamespaces.filter(function (ns) {
            return !state.ns || ns.name === state.ns;
        });
        var user = list.filter(function (ns) {
            return !ns.system;
        });
        var system = list.filter(function (ns) {
            return ns.system;
        });
        var card = el('div', 'open-card' + (user.length ? '' : ' clear'));
        var head = el('div', 'open-head');
        add(head, K.icon(user.length ? 'shieldOff' : 'shieldCheck'), el('h2', '', user.length ? 'Wide open: ' + plural(user.length, 'namespace') + ' with pods and no policy' : state.ns ? state.ns + ' has a policy' : 'Every namespace with pods has a policy'));
        card.appendChild(head);
        if (state.notice) {
            var note = el('div', 'notice');
            add(note, K.icon('check'), el('span', '', state.notice));
            card.appendChild(note);
        }
        if (user.length) {
            var row = el('div', 'open-list');
            user.slice(0, 10).forEach(function (ns) {
                var item = el('span', 'open-ns');
                add(item, K.icon('ns'), el('span', 'open-ns-name', ns.name), el('span', 'faint', plural(ns.pods.length, 'pod')));
                if (state.ctx.write) {
                    var iso = K.button('Isolate', 'small', 'shieldPlus', function () {
                        K.isolate(sdk, ns.name)
                            .then(function (res) {
                                if (!res) return;
                                notice('Asked to create NetworkPolicy default-deny-ingress in ' + ns.name + '. Its pods now only accept what a policy allows.');
                            })
                            .catch(fail);
                    });
                    iso.title = 'Create a Kubernetes NetworkPolicy "default-deny-ingress" (podSelector {}, policyTypes [Ingress]) in ' + ns.name + '. You see it before it is made.';
                    item.appendChild(iso);
                }
                row.appendChild(item);
            });
            if (user.length > 10) row.appendChild(el('span', 'faint small', 'and ' + (user.length - 10) + ' more'));
            card.appendChild(row);
        } else {
            card.appendChild(
                el(
                    'p',
                    'quiet',
                    state.ns
                        ? covered + ' of ' + plural(pods.length, 'workload') + ' in ' + state.ns + ' ' + (covered === 1 ? 'is' : 'are') + ' selected by a policy. Trace one to see what it lets through.'
                        : 'Each namespace running workloads has at least one policy selecting a pod in it. Trace a workload to see what it lets through.',
                ),
            );
        }
        if (system.length) {
            card.appendChild(el('p', 'faint small', 'System namespaces without policy: ' + C.names(system, 5) + '.'));
            card.lastChild.style.marginTop = '8px';
        }
        box.appendChild(card);
    }

    function notice(text) {
        state.notice = text;
        render(true);
        setTimeout(function () {
            if (state.notice === text) {
                state.notice = '';
                if (state.model) render(true);
            }
        }, 7000);
    }

    // ----- the lanes -----------------------------------------------------------------

    function card(model, pol) {
        var c = el('button', 'pcard k-' + pol.kind.replace(/^s(?=np|gnp|knp)/, '') + (pol.staged ? ' staged' : '') + (pol.error || pol.ruleErrors ? ' bad' : '') + (state.selected === pol.key ? ' sel' : ''));
        c.type = 'button';
        c.dataset.key = pol.key;
        var head = el('div', 'pcard-head');
        add(head, K.kindBadge(pol), el('span', 'pcard-name', pol.name));
        if (pol.staged) head.appendChild(el('span', 'kbadge k-staged push', 'staged'));
        c.appendChild(head);

        var where = el('div', 'pcard-where');
        if (pol.global) {
            add(where, K.icon('globe'), el('span', '', pol.namespaceSelector ? 'global · ns ' + pol.namespaceSelector : 'global · every namespace'));
        } else {
            add(where, K.icon('ns'), el('span', '', pol.namespace + (pol.kind === 'knp' || pol.kind === 'sknp' ? ' · Kubernetes' : '')));
        }
        c.appendChild(where);

        var sel = el('div', 'pcard-sel', pol.kind === 'knp' || pol.kind === 'sknp' ? pol.selector || 'every pod' : pol.selector || 'all()');
        c.appendChild(sel);

        var rules = el('div', 'pcard-rules');
        [
            ['in', pol.ingress, pol.rulesIn],
            ['out', pol.egress, pol.rulesOut],
        ].forEach(function (d) {
            var row = el('div', 'pcard-dir' + (d[1] ? '' : ' off'));
            row.appendChild(el('span', 'dir-tag', d[0]));
            if (d[1]) row.appendChild(d[2].length ? K.pips(d[2], 14) : el('span', 'pips-none', 'no rules — denies at tier end'));
            else row.appendChild(el('span', 'off-text', '—'));
            rules.appendChild(row);
        });
        c.appendChild(rules);

        var foot = el('div', 'pcard-foot');
        if (pol.error) {
            add(foot, add(el('span', 'bad-text'), K.icon('alert'), 'selector error'));
        } else if (!pol.matches.length) {
            add(foot, add(el('span', 'warn-text'), K.icon('alert'), 'applies to nothing'));
        } else {
            add(foot, add(el('span'), K.icon('pod'), plural(pol.matches.length, 'workload')));
            if (pol.global && pol.namespaces.length) foot.appendChild(el('span', 'faint push', 'in ' + plural(pol.namespaces.length, 'ns', 'ns')));
        }
        if (pol.ruleErrors) add(foot, add(el('span', 'bad-text push'), 'rule error'));
        c.appendChild(foot);
        c.title = pol.info.label + ' ' + (pol.namespace ? pol.namespace + '/' : '') + pol.name + '\nselector: ' + pol.selectorText + (pol.error ? '\n' + pol.error : '');
        return c;
    }

    function endcap(tier) {
        var pass = tier.defaultAction === 'Pass';
        var cap = el('div', 'endcap ' + (pass ? 'pass' : 'deny'));
        add(cap, el('span', 'endcap-label', 'End of tier'), K.icon(pass ? 'pass' : 'deny'), el('span', 'endcap-action', tier.defaultAction), el('span', 'endcap-note', pass ? 'what no rule decided goes on to the next tier' : 'what the selected pods’ rules did not allow is dropped'));
        cap.title = 'defaultAction: ' + tier.defaultAction;
        return cap;
    }

    function lane(model, tier, index) {
        var shown = tier.policies.filter(function (p) {
            return visible(model, p);
        });
        var node = el('section', 'lane' + (shown.length ? '' : ' slim'));
        var head = el('div', 'lane-head');
        var step = el('span', 'lane-step');
        add(step, el('b', '', String(index + 1)), 'tier');
        var name = el('div', 'lane-name');
        add(name, K.icon('tier'), el('span', '', tier.name));
        name.title = tier.name;
        var meta = el('div', 'lane-meta');
        add(meta, el('span', '', 'order ' + K.orderText(tier.order)), el('span', '', '· ' + plural(tier.policies.length, 'policy', 'policies')), tier.builtin && tier.exists ? el('span', '', '· built-in') : null);
        var chips = el('div', 'lane-meta');
        chips.appendChild(K.chip('default ' + tier.defaultAction, tier.defaultAction === 'Pass' ? 'bgp' : 'error', tier.defaultAction === 'Pass' ? 'pass' : 'deny', 'What the tier does with traffic its policies select but do not decide'));
        if (!tier.exists) chips.appendChild(K.chip('does not exist', 'error', 'alert', 'Policies name this tier, but there is no Tier object'));
        add(head, step, name, meta, chips);
        if (tier.obj) {
            head.classList.add('openable');
            head.title = 'Open the Tier ' + tier.name;
            head.addEventListener('click', function () {
                open({ kind: C.KINDS.tiers, namespace: '', name: tier.name });
            });
        }
        node.appendChild(head);

        var body = el('div', 'lane-body');
        if (!shown.length) {
            var empty = el('div', 'lane-empty');
            var filtered = tier.policies.length > 0;
            add(empty, K.icon(filtered ? 'filter' : 'pass'), filtered ? 'None of its ' + plural(tier.policies.length, 'policy', 'policies') + ' match the filters.' : 'No policies — every workload skips this tier.');
            body.appendChild(empty);
            node.appendChild(body);
            return node;
        }
        var track = el('div', 'track');
        shown.slice(0, MAX_CARDS).forEach(function (p) {
            var wrap = el('div', 'pcard-wrap');
            wrap.appendChild(el('span', 'order-mark', K.orderText(p.order)));
            wrap.appendChild(card(model, p));
            track.appendChild(wrap);
        });
        if (shown.length > MAX_CARDS) {
            var more = el('div', 'btile-more');
            add(more, el('strong', '', '+' + (shown.length - MAX_CARDS)), 'narrow with the filters');
            track.appendChild(more);
        }
        var capWrap = el('div', 'pcard-wrap cap');
        capWrap.appendChild(endcap(tier));
        track.appendChild(capWrap);
        body.appendChild(track);
        node.appendChild(body);
        return node;
    }

    function drawLanes(model) {
        var root = $('lanes');
        root.textContent = '';
        if (!model.policies.length) {
            root.appendChild(gettingStarted(model));
        }
        model.tiers.forEach(function (tier, i) {
            if (i > 0) {
                var joint = el('div', 'lane-link');
                add(joint, K.icon('down'), 'then');
                root.appendChild(joint);
            }
            root.appendChild(lane(model, tier, i));
        });
        var end = el('div', 'lane-link');
        add(end, K.icon('down'), 'no policy selected the workload, or every tier passed: the namespace profile allows it');
        root.appendChild(end);
    }

    function gettingStarted(model) {
        var box = el('div', 'getting-started');
        add(box, el('h2', '', 'No network policy yet'), el('p', '', 'Calico is enforcing nothing, so every pod accepts traffic from anywhere. A good first step is a default-deny policy per namespace — Isolate above creates one — followed by policies that allow what each app needs. A cluster-wide default that leaves Calico and Kubernetes system namespaces alone looks like this:'));
        var pre = el('pre', 'snippet');
        pre.textContent = [
            'apiVersion: projectcalico.org/v3',
            'kind: GlobalNetworkPolicy',
            'metadata:',
            '  name: default-deny',
            'spec:',
            "  selector: projectcalico.org/namespace not in {'kube-system', 'calico-system', 'calico-apiserver', 'tigera-operator'}",
            '  types: [Ingress, Egress]',
            '  egress:',
            '    - action: Allow',
            '      protocol: UDP',
            '      destination:',
            "        selector: k8s-app == 'kube-dns'",
            '        ports: [53]',
        ].join('\n');
        box.appendChild(pre);
        box.appendChild(
            K.button('Calico: get started with network policy', 'ghost small', 'open', function () {
                sdk.openUrl('https://docs.tigera.io/calico/latest/network-policy/get-started/calico-policy/calico-network-policy').catch(fail);
            }),
        );
        box.style.marginBottom = '12px';
        return box;
    }

    // ----- the drawer --------------------------------------------------------------

    function pick(key) {
        state.selected = key;
        writeHash();
        render(true);
        if (key) $('drawer').scrollTop = 0;
    }

    function dsec(title, body, count) {
        var node = el('section', 'dsec');
        var h = el('h3', 'mini-title', title);
        if (count !== undefined) h.appendChild(el('span', 'count muted', String(count)));
        node.appendChild(h);
        add(node, body);
        return node;
    }

    function workloads(pods, limit) {
        var box = el('div');
        var byNs = {};
        pods.forEach(function (p) {
            (byNs[p.namespace] = byNs[p.namespace] || []).push(p);
        });
        var left = limit;
        Object.keys(byNs)
            .sort()
            .forEach(function (ns) {
                if (left <= 0) return;
                var g = el('div', 'wl-group');
                var head = el('div', 'wl-ns');
                add(head, K.icon('ns'), el('span', '', ns), el('span', '', '· ' + byNs[ns].length));
                g.appendChild(head);
                var list = el('div', 'wl-list');
                byNs[ns].slice(0, left).forEach(function (p) {
                    var b = K.button('', 'wl', null, function () {
                        open(C.podRef(p.obj));
                    });
                    add(b, K.sdot(p.ready ? 'ok' : p.phase === 'Pending' ? 'warn' : 'error'), el('span', '', p.name));
                    b.title = p.namespace + '/' + p.name + ' on ' + (p.node || '?') + (p.ips.length ? ' · ' + p.ips.join(', ') : '');
                    list.appendChild(b);
                });
                left -= byNs[ns].length;
                g.appendChild(list);
                box.appendChild(g);
            });
        if (pods.length > limit) box.appendChild(el('p', 'faint small', 'and ' + (pods.length - limit) + ' more'));
        return box;
    }

    function drawDrawer(model) {
        var box = $('drawer');
        var pol = state.selected ? C.policyByKey(model, state.selected) : null;
        document.body.classList.toggle('drawer-open', !!pol);
        if (!pol) {
            box.hidden = true;
            box.textContent = '';
            return;
        }
        var scroll = box.scrollTop;
        box.textContent = '';
        box.hidden = false;

        var top = el('div', 'd-top');
        var tools = el('div', 'd-tools');
        add(
            tools,
            K.button('Open', 'ghost small', 'open', function () {
                open(pol.ref);
            }),
            K.button('YAML', 'ghost small', 'edit', function () {
                sdk.edit(pol.ref).catch(fail);
            }),
            K.iconButton('close', 'Close (Esc)', function () {
                pick('');
            }),
        );
        add(top, K.kindBadge(pol, true), el('span', 'faint small', pol.info.label), tools);
        box.appendChild(top);
        box.appendChild(el('h2', 'd-title', pol.name));
        var sub = el('div', 'd-sub');
        add(sub, pol.global ? add(el('span'), 'global') : add(el('span'), 'namespace ', el('strong', '', pol.namespace)), el('span', '', '· tier ' + pol.tier), el('span', '', '· order ' + K.orderText(pol.order)));
        pol.types.forEach(function (t) {
            sub.appendChild(K.chip(t, 'outline'));
        });
        if (pol.doNotTrack) sub.appendChild(K.chip('doNotTrack', 'muted'));
        if (pol.preDNAT) sub.appendChild(K.chip('preDNAT', 'muted'));
        if (pol.applyOnForward) sub.appendChild(K.chip('applyOnForward', 'muted'));
        box.appendChild(sub);

        if (pol.error) {
            var bad = el('div', 'why error');
            add(bad, K.icon('alert'), el('span', '', 'Calico cannot program this policy: ' + pol.error + '. It selects nothing until the selector is fixed.'));
            box.appendChild(bad);
        }
        if (pol.staged) {
            box.appendChild(el('div', 'dsec note', 'Staged (' + pol.stagedAction + '): Calico previews what this policy would do in flow logs, and does not enforce it. Turn it into a real policy to enforce it.'));
        }
        if (pol.kind === 'knp' || pol.kind === 'sknp') {
            box.appendChild(el('div', 'dsec note', 'Calico enforces Kubernetes NetworkPolicies itself: each is evaluated in the default tier at order 1000, after Calico policies with a lower order. A pod it selects only accepts the traffic some policy allows for the directions listed.'));
        }

        // Where it sits.
        var tier = pol.tierRef;
        var siblings = tier.policies.filter(function (p) {
            return !p.staged || p === pol;
        });
        var at = siblings.indexOf(pol);
        var before = siblings[at - 1];
        var after = siblings[at + 1];
        var pos = el('p', 'quiet');
        add(pos, 'Tier ', el('strong', '', tier.name), ' is evaluated ' + ordinal(tier.index + 1) + ' of ' + model.tiers.length + '. In it, this is policy ' + (at + 1) + ' of ' + siblings.length);
        if (before) add(pos, ', after ', K.link(before.name, function () {
            pick(before.key);
        }));
        if (after) add(pos, before ? ' and before ' : ', before ', K.link(after.name, function () {
            pick(after.key);
        }));
        add(pos, '. Traffic no rule decides is ' + (tier.defaultAction === 'Pass' ? 'passed on' : 'denied') + ' at the end of the tier.');
        box.appendChild(dsec('Where it sits', pos));

        // What it selects.
        var selBox = el('div');
        if (pol.kind === 'knp' || pol.kind === 'sknp') {
            selBox.appendChild(K.selectorCode(pol.selector || '{} — every pod in ' + pol.namespace));
            var eq = el('p', 'faint small', 'As Calico evaluates it: ');
            eq.appendChild(el('code', '', pol.calicoSelector));
            eq.style.marginTop = '6px';
            selBox.appendChild(eq);
        } else {
            var sel = window.CalicoSelector.parse(pol.selector);
            selBox.appendChild(K.selectorCode(pol.selector || 'all()', sel.ok ? '' : sel.error));
            if (pol.namespaceSelector) {
                selBox.appendChild(el('div', 'mini-title', 'in namespaces matching'));
                selBox.lastChild.style.margin = '8px 0 4px';
                var nsSel = window.CalicoSelector.parse(pol.namespaceSelector);
                selBox.appendChild(K.selectorCode(pol.namespaceSelector, nsSel.ok ? '' : nsSel.error));
            }
            if (pol.serviceAccountSelector) {
                selBox.appendChild(el('div', 'mini-title', 'running as service accounts matching'));
                selBox.lastChild.style.margin = '8px 0 4px';
                var saSel = window.CalicoSelector.parse(pol.serviceAccountSelector);
                selBox.appendChild(K.selectorCode(pol.serviceAccountSelector, saSel.ok ? '' : saSel.error));
            }
            if (!pol.global) {
                var scope = el('p', 'faint small', 'Only pods in ' + pol.namespace + ' are considered.');
                scope.style.marginTop = '6px';
                selBox.appendChild(scope);
            }
        }
        box.appendChild(dsec('Selects', selBox));

        var applies = el('div');
        if (pol.matches.length) {
            applies.appendChild(workloads(pol.matches, MAX_WORKLOADS));
            var tr = K.button('Trace one of them', 'ghost small', 'trace', function () {
                state.mode = 'trace';
                state.pod = pol.matches[0].key;
                state.traceNs = pol.matches[0].namespace;
                state.selected = '';
                writeHash();
                render(true);
                window.scrollTo(0, 0);
            });
            tr.style.marginTop = '10px';
            applies.appendChild(tr);
        } else {
            applies.appendChild(el('p', 'quiet', pol.error ? 'Nothing — the selector does not parse.' : 'No pod matches right now' + (pol.global ? '. A global policy may still select host endpoints.' : '.')));
        }
        box.appendChild(dsec('Applies to', applies, pol.matches.length));

        box.appendChild(dsec('Ingress rules' + (pol.ingress ? '' : ' (not applied)'), K.ruleFlow(pol, 'in'), pol.rulesIn.length));
        box.appendChild(dsec('Egress rules' + (pol.egress ? '' : ' (not applied)'), K.ruleFlow(pol, 'out'), pol.rulesOut.length));
        box.scrollTop = scroll;
    }

    function ordinal(n) {
        var s = ['th', 'st', 'nd', 'rd'];
        var v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    // ----- trace -----------------------------------------------------------------------

    function drawTrace(model) {
        var box = $('trace');
        if (box.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
        box.textContent = '';
        var pod = state.pod ? model.podByKey[state.pod] : null;
        if (pod && !state.traceNs) state.traceNs = pod.namespace;

        var bar = el('div', 'trace-bar');
        add(bar, K.icon('trace', 'lead'), el('h2', '', 'Trace a workload'));
        var nsSel = el('select', 'picker');
        nsSel.setAttribute('aria-label', 'Namespace');
        var nsList = model.namespaces
            .filter(function (ns) {
                return ns.pods.length;
            })
            .sort(function (a, b) {
                return a.name < b.name ? -1 : 1;
            });
        var first = el('option', '', 'Namespace…');
        first.value = '';
        nsSel.appendChild(first);
        nsList.forEach(function (ns) {
            var o = el('option', '', ns.name + ' (' + ns.pods.length + ')');
            o.value = ns.name;
            if (ns.name === state.traceNs) o.selected = true;
            nsSel.appendChild(o);
        });
        nsSel.addEventListener('change', function () {
            state.traceNs = nsSel.value;
            var entry = model.namespaceByName[nsSel.value];
            state.pod = entry && entry.pods.length ? entry.pods[0].key : '';
            writeHash();
            render(true);
        });
        var podSel = el('select', 'picker');
        podSel.setAttribute('aria-label', 'Pod');
        var q = state.query.trim().toLowerCase();
        var entry = model.namespaceByName[state.traceNs];
        var candidates = (entry ? entry.pods : []).filter(function (p) {
            return !q || p.name.toLowerCase().indexOf(q) >= 0;
        });
        var none = el('option', '', candidates.length ? 'Pod…' : state.traceNs ? 'no pod matches' : 'pick a namespace first');
        none.value = '';
        podSel.appendChild(none);
        candidates.slice(0, 500).forEach(function (p) {
            var o = el('option', '', p.name);
            o.value = p.key;
            if (p.key === state.pod) o.selected = true;
            podSel.appendChild(o);
        });
        podSel.addEventListener('change', function () {
            state.pod = podSel.value;
            writeHash();
            render(true);
        });
        add(bar, nsSel, podSel, el('span', 'faint small push', 'Follows the pod’s traffic through every tier, in order, to where Calico decides it.'));
        box.appendChild(bar);

        if (!pod) {
            var empty = el('div', 'trace-empty');
            add(empty, K.icon('trace'), el('p', '', state.pod ? 'That pod is gone. Pick another.' : 'Pick a pod to see which policies select it, in the order Calico evaluates them, and where its traffic is allowed or dropped.'));
            box.appendChild(empty);
            return;
        }

        var head = el('div', 'trace-pod');
        var name = el('div', 'trace-pod-name');
        add(name, K.icon('pod'), el('span', '', pod.name), K.sdot(pod.ready ? 'ok' : 'warn'));
        var meta = el('div', 'faint small');
        meta.textContent = pod.namespace + ' · on ' + (pod.node || 'no node') + (pod.ips.length ? ' · ' + pod.ips.join(', ') : '') + ' · service account ' + pod.serviceAccount;
        var labels = el('div', 'trace-labels');
        var keys = Object.keys(pod.labels).filter(function (k) {
            return k !== 'pod-template-hash';
        });
        keys.slice(0, 10).forEach(function (k) {
            labels.appendChild(el('span', 'label-chip', k + '=' + pod.labels[k]));
        });
        if (keys.length > 10) labels.appendChild(el('span', 'faint small', '+' + (keys.length - 10)));
        var tools = el('div', 'd-tools');
        add(
            tools,
            K.button('Open pod', 'ghost small', 'open', function () {
                open(C.podRef(pod.obj));
            }),
        );
        var left = el('div');
        add(left, name, meta);
        add(head, left, labels, tools);
        box.appendChild(head);

        var cols = el('div', 'traces');
        cols.appendChild(traceColumn(model, pod, 'in'));
        cols.appendChild(traceColumn(model, pod, 'out'));
        box.appendChild(cols);
    }

    var ACTION_CLASS = { Allow: 'allow', Deny: 'deny', Pass: 'pass', Log: 'pass' };

    function traceColumn(model, pod, dir) {
        var t = C.trace(model, pod, dir);
        var col = el('section', 'trace-col');
        var head = el('div', 'dirhead');
        add(head, K.icon(dir === 'in' ? 'down' : 'arrow'), el('h3', '', dir === 'in' ? 'Inbound — ingress' : 'Outbound — egress'), el('span', 'faint small push', plural(t.applied, 'tier') + ' apply'));
        col.appendChild(head);

        var path = el('ol', 'tpath');
        var start = el('li', 'tstop start flowing');
        var mark = el('span', 'tmark');
        mark.appendChild(K.icon(dir === 'in' ? 'globe' : 'pod'));
        var body = el('div', 'tbody');
        add(body, el('div', 'ttitle', dir === 'in' ? 'A connection to ' + pod.name : 'A connection from ' + pod.name), el('div', 'tnote', dir === 'in' ? 'arrives at the pod’s interface on ' + (pod.node || 'its node') : 'leaves the pod on ' + (pod.node || 'its node')));
        add(start, mark, body);
        path.appendChild(start);

        t.steps.forEach(function (step) {
            var cls = step.skipped ? 'skipped' : step.reach === 'none' ? 'unreached' : ACTION_CLASS[step.outcome.action] || '';
            var item = el('li', 'tstop ' + cls + (step.skipped || step.reach !== 'none' ? ' flowing' : ''));
            var m = el('span', 'tmark');
            m.appendChild(K.icon(step.skipped ? 'pass' : step.reach === 'none' ? 'ban' : 'tier'));
            var b = el('div', 'tbody');
            var title = el('div', 'ttitle');
            add(title, el('span', '', step.tier.name), el('span', 'faint', 'order ' + K.orderText(step.tier.order)));
            if (step.skipped) {
                title.appendChild(el('span', 'faint', '· skipped'));
                b.appendChild(title);
                b.appendChild(el('div', 'tnote', 'No enforced policy here selects this pod for ' + (dir === 'in' ? 'ingress' : 'egress') + '.'));
            } else if (step.reach === 'none') {
                title.appendChild(el('span', 'faint', '· not reached'));
                b.appendChild(title);
                b.appendChild(el('div', 'tnote', 'Its policies select this pod, but an earlier tier has already decided.'));
            } else {
                title.appendChild(K.actionPill(step.outcome.action, true));
                b.appendChild(title);
                if (step.reach === 'some') b.appendChild(el('div', 'tnote', 'Only traffic an earlier tier passed on gets here.'));
            }
            if (step.policies.length) {
                var list = el('div', 'tpolicies');
                step.policies.forEach(function (p) {
                    list.appendChild(
                        K.policyLine(
                            p,
                            function () {
                                pick(p.key);
                            },
                            { dir: dir },
                        ),
                    );
                });
                b.appendChild(list);
            }
            if (!step.skipped && step.reach !== 'none') {
                var o = step.outcome;
                var text = o.tierDefault
                    ? 'What these rules do not decide meets the tier default: ' + o.action + (o.action === 'Pass' ? ' — on to the next tier.' : '.')
                    : o.policy.name + ' rule ' + (o.rule + 1) + ' matches everything left: ' + o.action + (o.action === 'Pass' ? ' — on to the next tier.' : '.');
                b.appendChild(el('div', 'tnote', text));
                if (step.partial) b.appendChild(el('div', 'tnote', step.partial.policy.name + ' rule ' + (step.partial.rule + 1) + ' passes some traffic on to later tiers.'));
            }
            add(item, m, b);
            path.appendChild(item);
        });

        var end = el('li', 'tstop ' + (ACTION_CLASS[t.result.action] || ''));
        var em = el('span', 'tmark');
        em.appendChild(K.icon(t.result.action === 'Allow' ? 'allow' : 'deny'));
        var eb = el('div', 'tbody');
        var res = el('div', 'tresult');
        var rh = el('div', 'tresult-head');
        add(rh, el('span', '', t.result.profile ? 'Allowed' : t.result.action === 'Allow' ? 'Allowed' : t.result.action === 'Deny' ? 'Denied' : t.result.action), t.result.profile ? el('span', 'faint small', 'namespace profile') : null);
        res.appendChild(rh);
        res.appendChild(el('p', '', t.result.text));
        if (t.result.passed) res.appendChild(el('p', 'passed', t.result.passed.text));
        eb.appendChild(res);
        add(end, em, eb);
        path.appendChild(end);
        col.appendChild(path);
        return col;
    }

    // ----- not installed ------------------------------------------------------------

    function drawEmpty(model) {
        var box = $('empty');
        box.textContent = '';
        box.hidden = false;
        box.appendChild(K.absent(sdk, state.ctx, model, state.summary, fail));
    }

    // ----- putting it together ---------------------------------------------------------

    function drawTop() {
        var seg = $('mode');
        seg.textContent = '';
        [
            ['board', 'Board', 'lanes'],
            ['trace', 'Trace', 'trace'],
        ].forEach(function (m) {
            var b = K.button(m[1], 'seg-btn' + (state.mode === m[0] ? ' on' : ''), m[2], function () {
                if (state.mode === m[0]) return;
                state.mode = m[0];
                writeHash();
                render(true);
                window.scrollTo(0, 0);
            });
            b.setAttribute('aria-pressed', String(state.mode === m[0]));
            seg.appendChild(b);
        });
        $('query').placeholder = state.mode === 'trace' ? 'Filter the pod list' : 'Find a policy, namespace or selector';
    }

    function render() {
        var model = state.model;
        if (!model) return;
        drawError();
        var where = state.ctx.contextName;
        if (model.version) where += ' · Calico ' + model.version;
        where += ' · evaluated top to bottom, left to right';
        $('where').textContent = where;
        $('query').parentNode.hidden = !model.installed;
        if (!model.installed) {
            drawEmpty(model);
            $('board').hidden = true;
            $('drawer').hidden = true;
            document.body.classList.remove('drawer-open');
            return;
        }
        $('empty').hidden = true;
        $('board').hidden = false;
        drawTop();
        var trace = state.mode === 'trace';
        $('bar').hidden = trace;
        $('coverage').hidden = trace;
        $('lanes').hidden = trace;
        $('trace').hidden = !trace;
        if (trace) {
            drawTrace(model);
        } else {
            drawBar(model);
            drawCoverage(model);
            drawLanes(model);
        }
        drawDrawer(model);
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

    // One click handler and one tip for every card, however often the lanes
    // are redrawn.
    $('lanes').addEventListener('click', function (event) {
        var c = event.target.closest && event.target.closest('.pcard');
        if (c) pick(state.selected === c.dataset.key ? '' : c.dataset.key);
    });
    $('scrim').addEventListener('click', function () {
        pick('');
    });

    $('logo').appendChild(K.logo());
    $('search-icon').appendChild(K.icon('search'));
    $('query').addEventListener('input', function () {
        state.query = $('query').value;
        render(true);
    });
    $('query').addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
            $('query').value = '';
            state.query = '';
            render(true);
        }
    });
    document.addEventListener('keydown', function (event) {
        if (event.key === '/' && (document.activeElement === document.body || !document.activeElement)) {
            event.preventDefault();
            $('query').focus();
        } else if (event.key === 'Escape' && state.selected && document.activeElement !== $('query')) {
            pick('');
        }
    });

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

    readHash();
    document.body.appendChild(
        K.grip({
            panel: $('drawer'),
            prop: '--drawer-w',
            className: 'drawer-grip',
            min: 380,
            room: 360,
            initial: state.width,
            label: 'Resize the inspector',
            onResize: function (px, done) {
                if (!done) return;
                state.width = px;
                writeHash();
            },
        }),
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
