// A policy's Calico panel -- for Calico NetworkPolicies, GlobalNetworkPolicies,
// their staged forms, and Kubernetes NetworkPolicies: where it sits in the
// order Calico evaluates, what it selects, and its rules one by one.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var C = window.Calico;
    var K = window.CalicoKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;
    var MAX_PODS = 14;

    var state = { ctx: null, sig: '' };

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

    // A titled block that folds, the way the app's own sections do; what
    // follows it goes into the returned body.
    function section(root, id, title, count, what) {
        var sec = sdk.ui.section({ id: id, title: title, count: count, what: what });
        root.appendChild(sec.root);
        return sec.body;
    }

    function ordinal(n) {
        var s = ['th', 'st', 'nd', 'rd'];
        var v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    function draw(model, pol) {
        var root = $('root');
        root.textContent = '';
        var k8s = pol.kind === 'knp' || pol.kind === 'sknp';

        var head = el('div', 'panel-head');
        add(head, K.kindBadge(pol, true), K.chip('tier ' + pol.tier, 'outline', 'tier'), K.chip('order ' + K.orderText(pol.order), 'outline'));
        pol.types.forEach(function (t) {
            head.appendChild(K.chip(t, 'muted'));
        });
        root.appendChild(head);

        // Where it sits.
        var tier = pol.tierRef;
        var siblings = tier.policies.filter(function (p) {
            return !p.staged || p === pol;
        });
        var at = siblings.indexOf(pol);
        var tone = pol.error ? 'error' : pol.staged ? 'warn' : pol.matches.length ? 'ok' : 'warn';
        var v = el('div', 'panel-verdict ' + tone);
        var body = el('div');
        var headline = pol.error
            ? 'Calico cannot program this policy'
            : pol.staged
              ? 'Staged: previewed, not enforced'
              : pol.matches.length
                ? 'Selects ' + plural(pol.matches.length, 'workload') + (pol.global ? ' in ' + plural(pol.namespaces.length, 'namespace') : '')
                : 'Applies to nothing';
        var detail = pol.error
            ? pol.error
            : 'Evaluated in tier ' + tier.name + ' (' + ordinal(tier.index + 1) + ' of ' + model.tiers.length + '), as policy ' + (at + 1) + ' of ' + siblings.length + '. What its rules do not decide is ' + (tier.defaultAction === 'Pass' ? 'passed to the next tier.' : 'denied at the end of the tier.');
        add(body, el('strong', '', headline), el('span', '', detail));
        add(v, K.icon(pol.error ? 'alert' : pol.staged ? 'eye' : pol.matches.length ? 'shieldCheck' : 'alert'), body);
        root.appendChild(v);

        if (k8s) {
            var note = el('div', 'why info');
            add(note, K.icon('info'), el('span', '', 'Calico enforces Kubernetes NetworkPolicies itself, in the default tier at order 1000: Calico policies with a lower order run first. A pod it selects only accepts what some policy allows, for the directions in policyTypes.'));
            note.style.margin = '0 0 4px';
            root.appendChild(note);
        }

        // What it selects.
        var selects = section(root, 'selects', 'Selects', pol.matches.length || undefined, 'what it selects');
        if (k8s) {
            selects.appendChild(K.selectorCode(pol.selector || '{} — every pod in ' + pol.namespace));
            var eq = el('p', 'faint small', 'Calico reads it as ');
            eq.appendChild(el('code', '', pol.calicoSelector));
            eq.style.marginTop = '4px';
            selects.appendChild(eq);
        } else {
            var sel = window.CalicoSelector.parse(pol.selector);
            selects.appendChild(K.selectorCode(pol.selector || 'all()', sel.ok ? '' : sel.error));
            if (pol.namespaceSelector) {
                var ns = window.CalicoSelector.parse(pol.namespaceSelector);
                var nl = el('p', 'faint small', 'in namespaces matching');
                nl.style.margin = '6px 0 4px';
                selects.appendChild(nl);
                selects.appendChild(K.selectorCode(pol.namespaceSelector, ns.ok ? '' : ns.error));
            }
            if (pol.serviceAccountSelector) {
                var sa = window.CalicoSelector.parse(pol.serviceAccountSelector);
                var sl = el('p', 'faint small', 'running as service accounts matching');
                sl.style.margin = '6px 0 4px';
                selects.appendChild(sl);
                selects.appendChild(K.selectorCode(pol.serviceAccountSelector, sa.ok ? '' : sa.error));
            }
        }
        if (pol.matches.length) {
            var list = el('div', 'wl-list');
            list.style.marginTop = '8px';
            pol.matches.slice(0, MAX_PODS).forEach(function (p) {
                var b = K.button('', 'wl', null, function () {
                    open(C.podRef(p.obj));
                });
                add(b, K.sdot(p.ready ? 'ok' : 'warn'), el('span', '', (pol.global ? p.namespace + '/' : '') + p.name));
                list.appendChild(b);
            });
            if (pol.matches.length > MAX_PODS) list.appendChild(el('span', 'faint small', 'and ' + (pol.matches.length - MAX_PODS) + ' more'));
            selects.appendChild(list);
        }

        // The rules.
        if (pol.ingress || pol.rulesIn.length) {
            section(root, 'ingress', 'Ingress' + (pol.ingress ? '' : ' (not applied)'), pol.rulesIn.length, 'the ingress rules').appendChild(K.ruleFlow(pol, 'in', { compact: true }));
        }
        if (pol.egress || pol.rulesOut.length) {
            section(root, 'egress', 'Egress' + (pol.egress ? '' : ' (not applied)'), pol.rulesOut.length, 'the egress rules').appendChild(K.ruleFlow(pol, 'out', { compact: true }));
        }

        var foot = el('div', 'd-tools');
        foot.style.justifyContent = 'flex-start';
        foot.appendChild(
            K.button('Policy board', 'ghost small', 'lanes', function () {
                sdk.openView('policies').catch(fail);
            }),
        );
        root.appendChild(foot);
    }

    function tick() {
        C.load(sdk)
            .then(function (model) {
                $('error').hidden = true;
                var ref = state.ctx.object;
                var root = $('root');
                if (!model.installed) {
                    root.textContent = '';
                    plain(root, 'info', 'Calico is not installed in ' + state.ctx.contextName + ', so nothing enforces this policy' + (ref.kind === C.KINDS.knps ? ' unless another network plugin does.' : '.'));
                    return;
                }
                var pol = C.policyForRef(model, ref.kind, ref.namespace, ref.name);
                if (!pol) {
                    root.textContent = '';
                    plain(root, 'info', 'This policy could not be read.');
                    return;
                }
                if (model.sig === state.sig) return;
                state.sig = model.sig;
                draw(model, pol);
            })
            .catch(fail)
            .then(function () {
                setTimeout(tick, POLL);
            });
    }

    sdk.ready()
        .then(function (context) {
            state.ctx = context;
            if (!context.object) {
                fail(new Error('This page is a panel, drawn for one network policy.'));
                return;
            }
            tick();
        })
        .catch(fail);
})();
