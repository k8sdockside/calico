// Flow logs: what Whisker (Calico 3.30+) saw in the last minutes, read
// through the app's service call -- who talks to whom, namespace to
// namespace, what was denied and by which policy, the window as a timeline,
// and every flow with its policy trace in a drawer.
//
// Whisker's API is GET /whisker-backend/flows on the whisker Service in
// calico-system: a JSON list, never paginated, of flows aggregated by
// Goldmane. Its port and scheme changed in 3.33, so the manifest declares
// both and the page tries the one the version suggests first. The operator
// puts a deny-all ingress policy on the whisker pod, which drops the API
// server's requests unless it runs on Whisker's node; that is explained, and
// for a Kubernetes-policy install the page offers a policy that lets the
// nodes in.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var C = window.Calico;
    var K = window.CalicoKit;
    var el = K.el;
    var add = K.add;
    var svg = K.svg;
    var plural = C.plural;

    var MODEL_POLL = 30000;
    var FLOW_POLL = 10000;
    var SLOW_POLL = 30000;
    var PAGE = 200;
    var MAP_ROWS = 10;
    var PATH = '/whisker-backend/flows';
    var NAMESPACE = 'calico-system';
    var SERVICE_PORT = { whisker: 8081, 'whisker-tls': 8443 };
    var STORE_KEY = 'flows.service';
    var ALLOW_POLICY = 'k8sdockside-whisker-from-nodes';
    var WINDOWS = [
        { id: '1m', label: '1 min', seconds: 60, words: 'minute' },
        { id: '5m', label: '5 min', seconds: 300, words: '5 minutes' },
        { id: '15m', label: '15 min', seconds: 900, words: '15 minutes' },
        { id: '1h', label: '1 hour', seconds: 3600, words: 'hour' },
    ];

    // Goldmane's policy kinds, and the plugin's kind each opens as.
    var HIT_KIND = {
        CalicoNetworkPolicy: 'nps',
        GlobalNetworkPolicy: 'gnps',
        NetworkPolicy: 'knps',
        StagedNetworkPolicy: 'snps',
        StagedGlobalNetworkPolicy: 'sgnps',
        StagedKubernetesNetworkPolicy: 'sknps',
    };
    var HIT_BADGE = {
        CalicoNetworkPolicy: ['NP', 'np', 'Calico network policy'],
        GlobalNetworkPolicy: ['GNP', 'gnp', 'Global network policy'],
        NetworkPolicy: ['K8s', 'knp', 'Kubernetes network policy'],
        StagedNetworkPolicy: ['NP', 'np', 'Staged network policy'],
        StagedGlobalNetworkPolicy: ['GNP', 'gnp', 'Staged global network policy'],
        StagedKubernetesNetworkPolicy: ['K8s', 'knp', 'Staged Kubernetes network policy'],
        ClusterNetworkPolicy: ['CNP', 'gnp', 'Cluster network policy'],
        Profile: ['Profile', 'staged', 'A namespace or service account profile'],
        EndOfTier: ['Tier end', 'staged', 'Nothing in the tier matched: its default action'],
    };
    var SPECIAL = {
        public: { label: 'Internet', color: 'var(--k-ipip)' },
        private: { label: 'Private network', color: 'var(--k-bgp)' },
        global: { label: 'Cluster-wide', color: 'var(--k-faint)' },
    };

    var state = {
        ctx: null,
        model: null,
        sig: '',
        summary: null,
        flows: null,
        fetchedAt: 0,
        answeredBy: '',
        serviceId: '',
        triedId: '',
        remembered: '',
        problem: null,
        loading: false,
        window: '5m',
        live: true,
        action: '',
        ns: '',
        query: '',
        limit: PAGE,
        selected: '',
        selectedFlow: null,
        mapMode: 'all',
        mapWidth: 0,
        width: 0,
        notice: '',
        busy: false,
        error: '',
    };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function message(err) {
        return (err && err.message) || String(err);
    }

    function fail(err) {
        state.error = message(err);
        drawError();
    }

    function drawError() {
        $('error').textContent = state.error;
        $('error').hidden = !state.error;
    }

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    function windowOf(id) {
        return (
            WINDOWS.filter(function (w) {
                return w.id === id;
            })[0] || WINDOWS[1]
        );
    }

    function writeHash() {
        K.writeHash({
            w: state.window === '5m' ? '' : state.window,
            live: state.live ? '' : 'off',
            a: state.action,
            ns: state.ns,
            q: state.query,
            map: state.mapMode === 'all' ? '' : state.mapMode,
            sel: state.selected,
            width: state.width,
        });
    }

    function readHash() {
        var h = K.readHash();
        if (h.w) state.window = windowOf(h.w).id;
        state.live = h.live !== 'off';
        state.action = h.a || '';
        state.ns = h.ns || '';
        state.query = h.q || '';
        state.mapMode = h.map === 'denied' ? 'denied' : 'all';
        state.selected = h.sel || '';
        if (Number(h.width) > 0) state.width = Number(h.width);
    }

    // ----- numbers ------------------------------------------------------------------

    function count(n) {
        return Number(n || 0).toLocaleString('en-US');
    }

    function bytes(n) {
        n = Number(n || 0);
        var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        var i = 0;
        while (n >= 1024 && i < units.length - 1) {
            n /= 1024;
            i++;
        }
        return (i === 0 || n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + ' ' + units[i];
    }

    function clock(ms) {
        if (!ms) return '—';
        var d = new Date(ms);
        var p = function (x) {
            return (x < 10 ? '0' : '') + x;
        };
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function share(part, whole) {
        if (!whole) return '0%';
        var pct = (part / whole) * 100;
        if (pct > 0 && pct < 1) return '<1%';
        return Math.round(pct) + '%';
    }

    // "3.30.2", "v3.33.0-0.dev" -> [3, 30]
    function versionOf(text) {
        var m = /(\d+)\.(\d+)/.exec(String(text || ''));
        return m ? [Number(m[1]), Number(m[2])] : null;
    }

    function atLeast(v, major, minor) {
        return !!v && (v[0] > major || (v[0] === major && v[1] >= minor));
    }

    // ----- reading a flow ---------------------------------------------------------

    function splitLabels(text) {
        return String(text || '')
            .split(' | ')
            .map(function (s) {
                return s.trim();
            })
            .filter(Boolean);
    }

    // One end of a flow. Goldmane names a pod by the name its replicas share
    // ("web-7c9d8-*"), a network by "PUBLIC NETWORK" or "PRIVATE NETWORK",
    // and gives no namespace for host endpoints and global network sets.
    function endpoint(name, namespace, labels) {
        name = name || '';
        namespace = namespace === '-' || namespace === 'Global' ? '' : namespace || '';
        var kind = name === 'PUBLIC NETWORK' ? 'public' : name === 'PRIVATE NETWORK' ? 'private' : namespace ? 'workload' : 'global';
        var group = kind === 'workload' ? 'ns:' + namespace : kind;
        return {
            name: name,
            namespace: namespace,
            kind: kind,
            group: group,
            id: namespace + '/' + name,
            labels: splitLabels(labels),
            display: kind === 'public' ? 'Internet' : kind === 'private' ? 'Private network' : name || '—',
        };
    }

    function hit(raw) {
        if (!raw) return null;
        return {
            kind: raw.kind || '',
            name: String(raw.name || '').replace(/^(staged:|knp\.default\.|__PROFILE__\.)/, ''),
            namespace: raw.namespace || '',
            // Profiles sit past every tier; flow logs name their tier __PROFILE__.
            tier: raw.tier === '__PROFILE__' ? '' : raw.tier || '',
            action: raw.action || '',
            policyIndex: Number(raw.policy_index || 0),
            ruleIndex: typeof raw.rule_index === 'number' ? raw.rule_index : -1,
            trigger: hit(raw.trigger),
        };
    }

    function hits(list) {
        return (list || []).map(hit).filter(Boolean);
    }

    // What decided a flow: the last enforced hit, which is where evaluation
    // stopped.
    function decider(list) {
        return list.length ? list[list.length - 1] : null;
    }

    function normalise(raw) {
        var policies = raw.policies || {};
        var f = {
            start: Date.parse(raw.start_time) || 0,
            end: Date.parse(raw.end_time) || 0,
            action: raw.action || 'Unknown',
            src: endpoint(raw.source_name, raw.source_namespace, raw.source_labels),
            dst: endpoint(raw.dest_name, raw.dest_namespace, raw.dest_labels),
            proto: String(raw.protocol || '').toUpperCase(),
            port: Number(raw.dest_port || 0),
            reporter: raw.reporter || '',
            enforced: hits(policies.enforced),
            pending: hits(policies.pending),
            packetsIn: Number(raw.packets_in || 0),
            packetsOut: Number(raw.packets_out || 0),
            bytesIn: Number(raw.bytes_in || 0),
            bytesOut: Number(raw.bytes_out || 0),
        };
        f.bytes = f.bytesIn + f.bytesOut;
        f.packets = f.packetsIn + f.packetsOut;
        f.key = [f.start, f.end, f.action, f.src.id, f.dst.id, f.proto, f.port, f.reporter].join('|');
        f.decider = decider(f.enforced);
        f.text = [
            f.action,
            f.src.namespace,
            f.src.display,
            f.dst.namespace,
            f.dst.display,
            f.proto,
            f.port ? String(f.port) : '',
            f.src.labels.join(' '),
            f.dst.labels.join(' '),
            f.enforced
                .concat(f.pending)
                .map(function (h) {
                    return h.tier + ' ' + h.name + ' ' + h.namespace;
                })
                .join(' '),
        ]
            .join(' ')
            .toLowerCase();
        return f;
    }

    // ----- policies ----------------------------------------------------------------

    function hitLabel(h) {
        if (!h) return 'nothing';
        if (h.kind === 'EndOfTier') return 'the end of tier ' + (h.tier || '?');
        if (h.kind === 'Profile') {
            if (/^kns\./.test(h.name)) return 'namespace ' + h.name.slice(4) + ' profile';
            if (/^ksa\./.test(h.name)) return 'service account ' + h.name.slice(4) + ' profile';
            return 'profile ' + h.name;
        }
        return (h.namespace ? h.namespace + '/' : '') + h.name;
    }

    function hitBadge(h) {
        var b = HIT_BADGE[h.kind] || [h.kind || '?', 'staged', h.kind];
        var node = el('span', 'kbadge k-' + b[1], b[0]);
        node.title = b[2];
        return node;
    }

    // The plugin's own reading of the policy a hit names, when there is one.
    function policyOf(h) {
        var m = state.model;
        var key = HIT_KIND[h.kind];
        if (!m || !key || !m.policies) return null;
        var kind = C.KINDS[key];
        for (var i = 0; i < m.policies.length; i++) {
            var p = m.policies[i];
            if (p.ref.kind !== kind || (p.namespace || '') !== (h.namespace || '')) continue;
            if (p.rawName === h.name || p.name === h.name || p.rawName === h.tier + '.' + h.name) return p;
        }
        return null;
    }

    function refOf(h) {
        var p = policyOf(h);
        if (p) return p.ref;
        var key = HIT_KIND[h.kind];
        return key ? { kind: C.KINDS[key], namespace: h.namespace, name: h.name } : null;
    }

    // The pods a flow end names, for opening them.
    function podsOf(ep) {
        var m = state.model;
        if (!m || ep.kind !== 'workload' || !m.pods) return [];
        var name = ep.name;
        var prefix = /\*$/.test(name) ? name.replace(/\*$/, '') : '';
        return m.pods.filter(function (p) {
            if (p.namespace !== ep.namespace) return false;
            return prefix ? p.name.indexOf(prefix) === 0 : p.name === name;
        });
    }

    function colorOf(group) {
        if (group.indexOf('ns:') !== 0) return (SPECIAL[group] || SPECIAL.global).color;
        var ns = group.slice(3);
        var m = state.model;
        if (m && m.colors && m.colors[ns]) return m.colors[ns];
        // A namespace with no addresses in IPAM gets a colour of its own, the
        // same one every time.
        var h = 0;
        for (var i = 0; i < ns.length; i++) h = (h * 31 + ns.charCodeAt(i)) >>> 0;
        return K.seriesColor(h % 8);
    }

    function groupLabel(group) {
        if (group.indexOf('ns:') === 0) return group.slice(3);
        return (SPECIAL[group] || SPECIAL.global).label;
    }

    // ----- asking Whisker ----------------------------------------------------------

    // Whisker listens on 8081 over http up to 3.32, on 8443 over https from
    // 3.33. The one that answered last time goes first.
    function serviceOrder() {
        var v = versionOf(state.model && state.model.version);
        var order = atLeast(v, 3, 33) ? ['whisker-tls', 'whisker'] : ['whisker', 'whisker-tls'];
        var first = state.serviceId || state.remembered;
        if (first && order.indexOf(first) > 0) {
            order = [first].concat(
                order.filter(function (id) {
                    return id !== first;
                }),
            );
        }
        return order;
    }

    function classify(err, serviceId) {
        var text = message(err);
        var kind = 'other';
        if (/did not answer within|timed? ?out|deadline/i.test(text)) kind = 'timeout';
        else if (/services\/proxy|forbidden|not allowed to reach/i.test(text)) kind = 'forbidden';
        else if (/no ready pod|no endpoints/i.test(text)) kind = 'no-pod';
        else if (/no service .*whisker/i.test(text)) kind = 'missing';
        else if (/more than \d+ MiB/i.test(text)) kind = 'too-big';
        return { kind: kind, message: text, serviceId: serviceId, at: Date.now() };
    }

    function fetchFlows() {
        if (state.loading || !sdk.services) return Promise.resolve();
        state.loading = true;
        drawWhere();
        var order = serviceOrder();
        var query = { startTimeGte: -windowOf(state.window).seconds, sortBy: 'Time' };

        function attempt(i) {
            var id = order[i];
            state.triedId = id;
            return sdk.services.get({ service: id, path: PATH, query: query }).then(
                function (answer) {
                    return { id: id, answer: answer };
                },
                function (err) {
                    // The Service has the other version's port: try that one.
                    if (i + 1 < order.length && /has no port|no service port/i.test(message(err))) return attempt(i + 1);
                    err.serviceId = id;
                    throw err;
                },
            );
        }

        return attempt(0)
            .then(function (res) {
                var a = res.answer;
                var body = null;
                try {
                    body = JSON.parse(a.body);
                } catch (e) {
                    body = null;
                }
                if (a.status < 200 || a.status > 299) {
                    var said = body && body.error ? body.error : String(a.body || '').trim().slice(0, 240);
                    throw Object.assign(new Error('Whisker (' + a.service + ') answered ' + a.status + (said ? ': ' + said : '')), { serviceId: res.id });
                }
                if (!body || typeof body !== 'object') {
                    throw Object.assign(new Error(a.service + ' did not answer with JSON (' + (a.contentType || 'no content type') + ') — is it Whisker?'), { serviceId: res.id });
                }
                state.flows = (body.items || []).map(normalise).sort(function (x, y) {
                    return y.end - x.end || y.start - x.start;
                });
                state.fetchedAt = Date.now();
                state.answeredBy = a.service;
                state.problem = null;
                if (state.serviceId !== res.id) {
                    state.serviceId = res.id;
                    K.store.set(sdk, STORE_KEY, res.id);
                }
                if (state.selected) {
                    var again = state.flows.filter(function (f) {
                        return f.key === state.selected;
                    })[0];
                    if (again) state.selectedFlow = again;
                }
            })
            .catch(function (err) {
                state.problem = classify(err, err.serviceId || state.triedId);
            })
            .then(function () {
                state.loading = false;
                render();
            });
    }

    function whiskerAbsent(m) {
        return !m.flows.whisker && (m.served.whiskers || m.podsKnown);
    }

    function canAsk() {
        var m = state.model;
        return !!(m && m.installed && sdk.services && !whiskerAbsent(m));
    }

    function flowLoop() {
        var go = state.live && !document.hidden && canAsk();
        (go ? fetchFlows() : Promise.resolve()).then(function () {
            setTimeout(flowLoop, state.problem && state.problem.kind === 'timeout' ? SLOW_POLL : FLOW_POLL);
        });
    }

    function refresh() {
        if (canAsk()) fetchFlows();
    }

    function modelLoop() {
        C.load(sdk)
            .then(function (model) {
                if (state.error) {
                    state.error = '';
                    drawError();
                }
                var first = !state.model;
                state.model = model;
                if (model.sig !== state.sig) {
                    state.sig = model.sig;
                    render();
                }
                if (first) flowLoop();
            })
            .catch(fail)
            .then(function () {
                setTimeout(modelLoop, MODEL_POLL);
            });
    }

    // ----- filtering ------------------------------------------------------------------

    // Everything the namespace and the search leave; the action is applied
    // on top, for the table only, so the counts can show what it hides.
    function scoped() {
        var q = state.query.trim().toLowerCase();
        var words = q ? q.split(/\s+/) : [];
        return (state.flows || []).filter(function (f) {
            if (state.ns && f.src.group !== state.ns && f.dst.group !== state.ns) return false;
            for (var i = 0; i < words.length; i++) if (f.text.indexOf(words[i]) < 0) return false;
            return true;
        });
    }

    function byAction(list) {
        var out = { Allow: 0, Deny: 0, Pass: 0, other: 0 };
        list.forEach(function (f) {
            if (f.action in out) out[f.action]++;
            else out.other++;
        });
        return out;
    }

    function setNamespace(group) {
        state.ns = state.ns === group ? '' : group;
        state.limit = PAGE;
        writeHash();
        render();
    }

    function setAction(action) {
        state.action = state.action === action ? '' : action;
        state.limit = PAGE;
        writeHash();
        render();
    }

    function select(f) {
        state.selected = f ? f.key : '';
        state.selectedFlow = f || null;
        writeHash();
        drawDrawer();
        if (f) $('drawer').scrollTop = 0;
    }

    // ----- the header ------------------------------------------------------------------

    function drawWhere() {
        if (!state.ctx) return;
        var parts = [state.ctx.contextName];
        var m = state.model;
        if (m && m.version) parts.push('Calico ' + C.shortVersion(m.version));
        if (state.answeredBy) parts.push(state.answeredBy);
        if (state.loading) parts.push('asking Whisker…');
        else if (state.fetchedAt) parts.push('updated ' + K.ago(state.fetchedAt) + (state.live ? '' : ' · paused'));
        $('where').textContent = parts.join(' · ');
    }

    function drawTop() {
        var seg = $('window');
        seg.textContent = '';
        WINDOWS.forEach(function (w) {
            var b = K.button(w.label, 'seg-btn' + (state.window === w.id ? ' on' : ''), null, function () {
                if (state.window === w.id) return;
                state.window = w.id;
                writeHash();
                drawTop();
                refresh();
            });
            b.title = 'Flows from the last ' + w.words;
            b.setAttribute('aria-pressed', state.window === w.id ? 'true' : 'false');
            seg.appendChild(b);
        });

        var live = $('live');
        live.textContent = '';
        live.className = 'ghost fl-live' + (state.live ? ' on' : '');
        add(live, el('i', 'fl-live-dot'), el('span', '', state.live ? 'Live' : 'Paused'));
        live.title = state.live ? 'Asking Whisker every ' + FLOW_POLL / 1000 + ' seconds — click to pause' : 'Paused — click to follow again';
    }

    // ----- empty and problem states ---------------------------------------------------

    function emptyBox(iconName, title, text) {
        var box = el('div', 'empty fl-empty');
        var art = el('div', 'empty-art');
        art.appendChild(K.icon(iconName));
        add(box, art, el('h2', '', title));
        if (text) box.appendChild(el('p', 'faint', text));
        return box;
    }

    function snippet(text) {
        return el('pre', 'snippet fl-snippet', text);
    }

    function row() {
        var r = el('div', 'fl-actions');
        add(r, Array.prototype.slice.call(arguments));
        return r;
    }

    function showEmpty(node) {
        var box = $('empty');
        box.textContent = '';
        box.appendChild(node);
        box.hidden = false;
        $('flows').hidden = true;
    }

    function noticeLine() {
        if (!state.notice) return null;
        var n = el('p', 'notice');
        add(n, K.icon('check'), el('span', '', state.notice));
        return n;
    }

    function drawNoServices() {
        showEmpty(emptyBox('flows', 'Flow logs need a newer K8s Dockside', 'This page asks Whisker for flows through the app, which K8s Dockside 0.0.27 and newer can do. Update the app to see flows here.'));
    }

    function drawNoWhisker(m) {
        var v = versionOf(m.version);
        var box = emptyBox(
            'flows',
            'Whisker is not running in ' + state.ctx.contextName,
            'Whisker is Calico’s flow log viewer. Goldmane gathers what Felix sees on every node, and Whisker serves it — this page reads Whisker. Both come with Calico 3.30 and the Tigera operator.',
        );
        var canCreate = m.operator && m.served.whiskers;
        if (!m.operator) {
            box.appendChild(el('p', 'faint small', 'This Calico is not managed by the Tigera operator, which is what installs Whisker and Goldmane.'));
        } else if (!m.served.whiskers) {
            box.appendChild(el('p', 'faint small', 'The operator here does not know the Whisker kind' + (m.version ? ' — Calico ' + C.shortVersion(m.version) + ' is older than 3.30' : '') + '.'));
        } else if (v && !atLeast(v, 3, 30)) {
            box.appendChild(el('p', 'faint small', 'Calico ' + C.shortVersion(m.version) + ' is older than 3.30; the operator may not start Whisker.'));
        }
        if (canCreate) {
            box.appendChild(el('p', 'fl-left small dim', 'Turning it on creates what the operator needs to start them:'));
            box.appendChild(snippet(['apiVersion: operator.tigera.io/v1', 'kind: Goldmane', 'metadata:', '  name: default', '---', 'apiVersion: operator.tigera.io/v1', 'kind: Whisker', 'metadata:', '  name: default'].join('\n')));
            add(box, noticeLine());
            // Once asked, the operator has it; the button would only ask again.
            var go = state.notice ? null : K.button(state.busy ? 'Asking…' : 'Turn on flow logs', 'primary', 'spark', turnOn);
            if (go) go.disabled = state.busy;
            box.appendChild(
                row(
                    go,
                    K.button('Whisker on GitHub', 'ghost', 'open', function () {
                        sdk.openUrl('https://github.com/projectcalico/calico/tree/master/whisker').catch(fail);
                    }),
                ),
            );
        }
        showEmpty(box);
    }

    function turnOn() {
        var m = state.model;
        if (!m || state.busy) return;
        state.busy = true;
        render();
        var steps = [];
        if (!m.flows.goldmane) steps.push({ kind: C.KINDS.goldmanes, kindName: 'Goldmane' });
        steps.push({ kind: C.KINDS.whiskers, kindName: 'Whisker' });
        var made = [];
        var chain = Promise.resolve(true);
        steps.forEach(function (s) {
            chain = chain.then(function (go) {
                if (!go) return false;
                return K.create(sdk, {
                    kind: s.kind,
                    namespace: '',
                    object: { apiVersion: 'operator.tigera.io/v1', kind: s.kindName, metadata: { name: 'default' }, spec: {} },
                }).then(function (res) {
                    if (!res) return false;
                    made.push(s.kindName);
                    return true;
                });
            });
        });
        chain
            .then(function () {
                if (made.length) state.notice = 'Asked the operator for ' + made.join(' and ') + '. They take a minute or two to start; this page picks Whisker up when it is running.';
            })
            .catch(fail)
            .then(function () {
                state.busy = false;
                render();
            });
    }

    // Every address the API server's requests could come from: the nodes'
    // own, and the tunnel addresses Calico gives them.
    function nodeAddresses(m) {
        var seen = {};
        var out = [];
        function take(ip) {
            ip = C.stripMask(ip || '');
            if (!ip || seen[ip]) return;
            seen[ip] = true;
            out.push(ip);
        }
        (m.nodes || []).forEach(function (n) {
            (n.internalIPs || []).concat([n.ipv4, n.ipv6]).forEach(take);
        });
        (m.nodes || []).forEach(function (n) {
            [n.ipip, n.vxlan, n.vxlan6, n.wg, n.wg6].forEach(take);
        });
        return out;
    }

    function cidrOf(ip) {
        return ip + (ip.indexOf(':') >= 0 ? '/128' : '/32');
    }

    // Which policy guards Whisker here: the Kubernetes NetworkPolicy of
    // 3.30-3.31, or the calico-system tier's policy from 3.32.
    function guard(m) {
        var k8s = null;
        var calico = null;
        (m.policies || []).forEach(function (p) {
            if (p.namespace !== NAMESPACE) return;
            if (p.ref.kind === C.KINDS.knps && p.rawName === 'whisker') k8s = p;
            if (p.ref.kind === C.KINDS.nps && /(^|\.)whisker$/.test(p.rawName) && p.tier === 'calico-system') calico = p;
        });
        if (calico) return { kind: 'calico', policy: calico };
        if (k8s) return { kind: 'k8s', policy: k8s };
        var v = versionOf(m.version);
        return { kind: v && atLeast(v, 3, 32) ? 'calico' : 'k8s', policy: null };
    }

    function allowPolicy(m, port) {
        return {
            apiVersion: 'networking.k8s.io/v1',
            kind: 'NetworkPolicy',
            metadata: {
                name: ALLOW_POLICY,
                namespace: NAMESPACE,
                labels: { 'app.kubernetes.io/managed-by': 'k8sdockside' },
            },
            spec: {
                podSelector: { matchLabels: { 'k8s-app': 'whisker' } },
                policyTypes: ['Ingress'],
                ingress: [
                    {
                        from: nodeAddresses(m).map(function (ip) {
                            return { ipBlock: { cidr: cidrOf(ip) } };
                        }),
                        ports: [{ protocol: 'TCP', port: port }],
                    },
                ],
            },
        };
    }

    function allowPolicyYaml(m, port) {
        var ips = nodeAddresses(m);
        var lines = [
            'apiVersion: networking.k8s.io/v1',
            'kind: NetworkPolicy',
            'metadata:',
            '  name: ' + ALLOW_POLICY,
            '  namespace: ' + NAMESPACE,
            'spec:',
            '  podSelector:',
            '    matchLabels:',
            '      k8s-app: whisker',
            '  policyTypes: [Ingress]',
            '  ingress:',
            '    - from:',
        ];
        ips.slice(0, 6).forEach(function (ip) {
            lines.push('        - ipBlock: { cidr: ' + cidrOf(ip) + ' }');
        });
        if (ips.length > 6) lines.push('        # … and ' + (ips.length - 6) + ' more node addresses');
        lines.push('      ports:', '        - { protocol: TCP, port: ' + port + ' }');
        return lines.join('\n');
    }

    function calicoPolicyYaml(m, port) {
        var ips = nodeAddresses(m);
        var nets = ips
            .slice(0, 6)
            .map(function (ip) {
                return '          - ' + cidrOf(ip);
            })
            .concat(ips.length > 6 ? ['          # … and ' + (ips.length - 6) + ' more node addresses'] : []);
        return [
            'apiVersion: projectcalico.org/v3',
            'kind: NetworkPolicy',
            'metadata:',
            '  name: calico-system.k8sdockside-whisker',
            '  namespace: ' + NAMESPACE,
            'spec:',
            '  tier: calico-system',
            '  order: 50',
            "  selector: k8s-app == 'whisker'",
            '  types: [Ingress]',
            '  ingress:',
            '    - action: Allow',
            '      protocol: TCP',
            '      source:',
            '        nets:',
        ]
            .concat(nets, ['      destination:', '        ports: [' + port + ']'])
            .join('\n');
    }

    function letNodesIn() {
        var m = state.model;
        if (!m || state.busy) return;
        var port = SERVICE_PORT[(state.problem && state.problem.serviceId) || state.triedId] || 8081;
        state.busy = true;
        render();
        K.create(sdk, { kind: C.KINDS.knps, namespace: NAMESPACE, object: allowPolicy(m, port) })
            .then(function (res) {
                if (!res) return;
                state.notice = 'Created ' + NAMESPACE + '/' + ALLOW_POLICY + '. Asking Whisker again…';
                state.problem = null;
                setTimeout(refresh, 1500);
            })
            .catch(fail)
            .then(function () {
                state.busy = false;
                render();
            });
    }

    function tryAgain() {
        return K.button(state.loading ? 'Asking…' : 'Try again', 'ghost', 'repeat', function () {
            state.notice = '';
            refresh();
        });
    }

    function drawProblem(m, p) {
        var port = SERVICE_PORT[p.serviceId] || 8081;
        var box;
        if (p.kind === 'timeout') {
            var g = guard(m);
            box = emptyBox('lock', 'The API server cannot reach Whisker', 'Whisker did not answer within 15 seconds. The app’s requests reach it through the API server, so they come from a node’s address — and the operator gives the whisker pod a policy that lets nothing in. Unless the API server runs on Whisker’s own node, they are dropped.');
            box.appendChild(el('p', 'faint small', p.message));
            var exists = (m.policies || []).some(function (x) {
                return x.ref.kind === C.KINDS.knps && x.namespace === NAMESPACE && x.rawName === ALLOW_POLICY;
            });
            if (g.kind === 'k8s') {
                box.appendChild(
                    el(
                        'p',
                        'fl-left dim',
                        exists
                            ? NAMESPACE + '/' + ALLOW_POLICY + ' is there already, and Whisker still does not answer. A managed control plane may not call from the nodes’ addresses; check where your API server’s requests come from.'
                            : 'Guarded by the Kubernetes NetworkPolicy ' + NAMESPACE + '/whisker. Kubernetes policies add up, so a second one that lets the ' + plural(m.nodes.length, 'node') + ' in on port ' + port + ' opens Whisker to them and nothing else:',
                    ),
                );
                if (!exists) {
                    box.appendChild(snippet(allowPolicyYaml(m, port)));
                    var go = K.button(state.busy ? 'Asking…' : 'Let the nodes in', 'primary', 'shieldPlus', letNodesIn);
                    go.disabled = state.busy || !nodeAddresses(m).length;
                    add(box, noticeLine(), row(go, tryAgain()));
                } else {
                    box.appendChild(row(tryAgain()));
                }
            } else {
                box.appendChild(
                    el(
                        'p',
                        'fl-left dim',
                        'Guarded by ' + (g.policy ? g.policy.name : 'calico-system.whisker') + ' in the calico-system tier, which ends in a deny — a Kubernetes NetworkPolicy is never reached. A Calico policy in that tier, ordered before it, can let the nodes in. The plugin does not write Calico policies; apply it with kubectl or calicoctl, and check it against your Calico version:',
                    ),
                );
                box.appendChild(snippet(calicoPolicyYaml(m, port)));
                box.appendChild(row(tryAgain()));
            }
            box.appendChild(el('p', 'faint small fl-left', 'Or reach Whisker from your machine: kubectl port-forward -n ' + NAMESPACE + ' service/whisker ' + port + ':' + port));
        } else if (p.kind === 'forbidden') {
            box = emptyBox('lock', 'Not allowed to call Whisker', 'Reaching a Service through the API server needs get on services/proxy. The built-in edit and admin roles have it; view does not. A Role like this one, bound to you, is enough:');
            box.appendChild(
                snippet(
                    [
                        'apiVersion: rbac.authorization.k8s.io/v1',
                        'kind: Role',
                        'metadata:',
                        '  name: whisker-flow-reader',
                        '  namespace: ' + NAMESPACE,
                        'rules:',
                        '  - apiGroups: [""]',
                        '    resources: ["services/proxy"]',
                        '    resourceNames: ["whisker:8081", "https:whisker:8443"]',
                        '    verbs: ["get"]',
                    ].join('\n'),
                ),
            );
            box.appendChild(el('p', 'faint small', p.message));
            box.appendChild(row(tryAgain()));
        } else if (p.kind === 'no-pod') {
            box = emptyBox('alert', 'Whisker has no ready pod', 'The whisker Service is there, but nothing behind it is ready to answer. The operator’s status for Whisker usually says why.');
            box.appendChild(el('p', 'faint small', p.message));
            box.appendChild(
                row(
                    K.button('Whisker', 'ghost', 'open', function () {
                        sdk.openView('whisker').catch(fail);
                    }),
                    K.button('Operator status', 'ghost', 'check', function () {
                        sdk.openView('tigera-status').catch(fail);
                    }),
                    tryAgain(),
                ),
            );
        } else if (p.kind === 'missing') {
            box = emptyBox('alert', 'There is no whisker Service in ' + NAMESPACE, 'Whisker runs here, but not where the operator puts it, so this page cannot find it.');
            box.appendChild(el('p', 'faint small', p.message));
            box.appendChild(row(tryAgain()));
        } else if (p.kind === 'too-big') {
            box = emptyBox('flows', 'Too many flows for one answer', 'Whisker sends the whole window at once, and this one is over the 8 MiB the app takes. Pick a shorter window.');
            var seg = el('div', 'seg');
            WINDOWS.forEach(function (w) {
                seg.appendChild(
                    K.button(w.label, 'seg-btn' + (state.window === w.id ? ' on' : ''), null, function () {
                        state.window = w.id;
                        writeHash();
                        drawTop();
                        refresh();
                    }),
                );
            });
            box.appendChild(row(seg));
        } else {
            box = emptyBox('alert', 'Whisker could not be read', p.message);
            box.appendChild(row(tryAgain()));
        }
        showEmpty(box);
    }

    // ----- the sentence ----------------------------------------------------------------

    function drawLede(list, all) {
        var p = $('lede');
        p.textContent = '';
        var w = windowOf(state.window);
        var b = function (t) {
            return el('strong', '', t);
        };
        var n = byAction(list);
        var groups = {};
        list.forEach(function (f) {
            groups[f.src.group] = true;
            groups[f.dst.group] = true;
        });
        if (!all.length) {
            add(p, 'Whisker saw no flows in the last ' + w.words + '. Goldmane keeps about an hour; a quiet cluster, or one where Felix does not send flows to Goldmane, reads like this.');
            return;
        }
        var scope = state.ns ? ' to or from ' + groupLabel(state.ns) : '';
        add(p, 'In the last ' + w.words + ' Whisker saw ', b(count(list.length) + (list.length === 1 ? ' flow' : ' flows')), scope, ' between ', b(plural(Object.keys(groups).length, 'place')), ': ', b(count(n.Allow) + ' allowed'));
        if (n.Pass) add(p, ', ', b(count(n.Pass) + ' passed on'));
        add(p, ' and ');
        var denied = b(count(n.Deny) + ' denied');
        if (n.Deny) denied.className = 'bad-text';
        add(p, denied, '.');
        if (n.Deny) {
            var top = deniedGroups(list)[0];
            if (top) add(p, ' Most denied: ', b(top.src.display + ' → ' + top.dst.display + (top.port ? ':' + top.port : '')), ', by ', b(hitLabel(top.decider)), '.');
        }
    }

    // ----- the numbers ------------------------------------------------------------------

    function stat(label, big, foot, extra) {
        var s = el('div', 'stat');
        s.appendChild(el('span', 'stat-label', label));
        var r = el('div', 'stat-row');
        if (extra) r.appendChild(extra);
        r.appendChild(big);
        s.appendChild(r);
        if (foot) s.appendChild(foot);
        return s;
    }

    function drawStats(list) {
        var box = $('stats');
        box.textContent = '';
        var n = byAction(list);
        var total = list.length;
        var traffic = 0;
        var packets = 0;
        var pairs = {};
        var places = {};
        var deniedFrom = {};
        list.forEach(function (f) {
            traffic += f.bytes;
            packets += f.packets;
            pairs[f.src.group + '>' + f.dst.group] = true;
            places[f.src.group] = true;
            places[f.dst.group] = true;
            if (f.action === 'Deny') deniedFrom[f.src.id] = true;
        });
        var allowedShare = total ? (n.Allow + n.Pass) / total : 0;

        add(
            box,
            stat('Flows', el('span', 'stat-big', count(total)), el('span', 'stat-foot', 'in the last ' + windowOf(state.window).words)),
            stat('Allowed', el('span', 'stat-big ok-text', count(n.Allow)), el('span', 'stat-foot', share(n.Allow, total) + ' of flows' + (n.Pass ? ' · ' + count(n.Pass) + ' passed' : '')), K.ring(allowedShare, 38, '', share(n.Allow, total) + ' allowed')),
            stat('Denied', el('span', 'stat-big' + (n.Deny ? ' bad-text' : ''), count(n.Deny)), el('span', 'stat-foot', n.Deny ? 'from ' + plural(Object.keys(deniedFrom).length, 'source') : 'nothing dropped')),
            stat('Traffic', el('span', 'stat-big', bytes(traffic)), el('span', 'stat-foot', count(packets) + ' packets')),
            stat('Talking', el('span', 'stat-big', count(Object.keys(places).length)), el('span', 'stat-foot', plural(Object.keys(pairs).length, 'pair') + ' of places')),
        );
    }

    // ----- who talks to whom ------------------------------------------------------------

    function cardHead(iconName, title, sub, extra) {
        var head = el('div', 'card-head');
        add(head, K.icon(iconName), el('h2', '', title));
        if (sub) head.appendChild(el('span', 'card-sub', sub));
        if (extra) {
            var right = el('div', 'push fl-head-tools');
            add(right, extra);
            head.appendChild(right);
        }
        return head;
    }

    function trim(text, max) {
        return text.length > max ? text.slice(0, max - 1) + '…' : text;
    }

    // Sources on the left, destinations on the right, a ribbon per pair and
    // verdict, as wide as its share of the flows.
    function drawMap(list) {
        var box = $('map');
        box.textContent = '';
        var modeSeg = el('div', 'seg');
        [
            ['all', 'All'],
            ['denied', 'Denied'],
        ].forEach(function (m) {
            modeSeg.appendChild(
                K.button(m[1], 'seg-btn' + (state.mapMode === m[0] ? ' on' : ''), null, function () {
                    state.mapMode = m[0];
                    writeHash();
                    drawMap(scoped());
                }),
            );
        });
        box.appendChild(cardHead('share', 'Who talks to whom', 'namespace to namespace · click one to follow it', modeSeg));

        var deniedOnly = state.mapMode === 'denied';
        var pairs = {};
        var out = {};
        var inn = {};
        list.forEach(function (f) {
            if (deniedOnly && f.action !== 'Deny') return;
            var k = f.src.group + '>' + f.dst.group;
            var p = pairs[k] || (pairs[k] = { src: f.src.group, dst: f.dst.group, ok: 0, deny: 0 });
            if (f.action === 'Deny') p.deny++;
            else p.ok++;
            out[f.src.group] = (out[f.src.group] || 0) + 1;
            inn[f.dst.group] = (inn[f.dst.group] || 0) + 1;
        });
        var keys = Object.keys(pairs);
        if (!keys.length) {
            box.appendChild(el('p', 'quiet', deniedOnly ? 'Nothing was denied in this window.' : 'No flows to draw.'));
            return;
        }

        // The busiest places on each side; the rest share one row.
        function side(totals) {
            var names = Object.keys(totals).sort(function (a, b) {
                return totals[b] - totals[a] || (a < b ? -1 : 1);
            });
            var shown = names.slice(0, MAP_ROWS);
            var rest = names.slice(MAP_ROWS);
            var rows = shown.map(function (g) {
                return { group: g, value: totals[g] };
            });
            if (rest.length) {
                rows.push({
                    group: 'other',
                    value: rest.reduce(function (s, g) {
                        return s + totals[g];
                    }, 0),
                    members: rest,
                });
            }
            return rows;
        }
        var left = side(out);
        var right = side(inn);
        function rowOf(rows, group) {
            for (var i = 0; i < rows.length; i++) if (rows[i].group === group) return rows[i];
            return rows[rows.length - 1];
        }

        var total = list.length && Object.keys(out).reduce(function (s, g) {
            return s + out[g];
        }, 0);
        // Drawn at the card's own width, so the labels keep their size.
        var W = Math.max(460, Math.round(box.clientWidth - 38));
        var gap = 8;
        var LABEL = 31;
        var nodeW = 12;
        var xL = Math.min(196, Math.round(W * 0.27));
        var xR = W - xL - nodeW;
        var labelMax = Math.max(10, Math.floor((xL - 14) / 7.2));
        state.mapWidth = W;
        var rowsMax = Math.max(left.length, right.length);
        // Each side's rows are as tall as their share of the flows, and a
        // row's label sits at least a label's height below the one above.
        var scale = Math.max(220, rowsMax * 30) / total;
        function tall(rows) {
            var y = 0;
            var prev = null;
            rows.forEach(function (r) {
                r.h = Math.max(4, r.value * scale);
                if (prev) y = Math.max(prev.off + prev.h + gap, prev.off + prev.h / 2 + LABEL - r.h / 2);
                r.off = y;
                prev = r;
            });
            return prev ? prev.off + prev.h : 0;
        }
        var tallL = tall(left);
        var tallR = tall(right);
        var H = Math.ceil(Math.max(tallL, tallR, 120) + 24);

        function place(rows, height) {
            var top = 12 + (H - 24 - height) / 2;
            rows.forEach(function (r) {
                r.y = top + r.off;
                r.cursor = r.y;
            });
        }
        place(left, tallL);
        place(right, tallR);

        var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'fl-sankey', role: 'img' });
        root.setAttribute('aria-label', 'Flows from ' + plural(left.length, 'source') + ' to ' + plural(right.length, 'destination'));

        // Ribbons, ordered so they do not cross more than they must.
        var ribbons = [];
        keys.forEach(function (k) {
            var p = pairs[k];
            var l = rowOf(left, p.src);
            var r = rowOf(right, p.dst);
            if (p.ok) ribbons.push({ l: l, r: r, value: p.ok, deny: false, src: p.src, dst: p.dst });
            if (p.deny) ribbons.push({ l: l, r: r, value: p.deny, deny: true, src: p.src, dst: p.dst });
        });
        var ribbonsOut = ribbons.slice().sort(function (a, b) {
            return a.l.y - b.l.y || a.r.y - b.r.y || (a.deny ? 1 : 0) - (b.deny ? 1 : 0);
        });
        ribbonsOut.forEach(function (rb) {
            rb.y0 = rb.l.cursor;
            rb.l.cursor += rb.value * (rb.l.h / rb.l.value);
        });
        var ribbonsIn = ribbons.slice().sort(function (a, b) {
            return a.r.y - b.r.y || a.l.y - b.l.y || (a.deny ? 1 : 0) - (b.deny ? 1 : 0);
        });
        ribbonsIn.forEach(function (rb) {
            rb.h1 = rb.value * (rb.r.h / rb.r.value);
            rb.y1 = rb.r.cursor;
            rb.r.cursor += rb.h1;
        });

        var bands = svg('g', { class: 'fl-bands' });
        ribbons.forEach(function (rb) {
            var h0 = rb.value * (rb.l.h / rb.l.value);
            var x0 = xL + nodeW;
            var x1 = xR;
            var xm = (x0 + x1) / 2;
            var d =
                'M' + x0 + ' ' + rb.y0.toFixed(1) +
                ' C' + xm + ' ' + rb.y0.toFixed(1) + ' ' + xm + ' ' + rb.y1.toFixed(1) + ' ' + x1 + ' ' + rb.y1.toFixed(1) +
                ' L' + x1 + ' ' + (rb.y1 + rb.h1).toFixed(1) +
                ' C' + xm + ' ' + (rb.y1 + rb.h1).toFixed(1) + ' ' + xm + ' ' + (rb.y0 + h0).toFixed(1) + ' ' + x0 + ' ' + (rb.y0 + h0).toFixed(1) +
                ' Z';
            var path = svg('path', { d: d, class: 'fl-ribbon' + (rb.deny ? ' deny' : '') });
            if (!rb.deny) path.style.fill = colorOf(rb.src === 'other' ? 'global' : rb.src);
            path.dataset.a = 'L' + rb.l.group;
            path.dataset.b = 'R' + rb.r.group;
            var t = svg('title');
            t.textContent = groupLabel(rb.src === 'other' ? 'global' : rb.src) + ' → ' + groupLabel(rb.dst === 'other' ? 'global' : rb.dst) + ': ' + plural(rb.value, 'flow') + (rb.deny ? ' denied' : ' allowed');
            path.appendChild(t);
            bands.appendChild(path);
        });
        root.appendChild(bands);

        function drawSide(rows, x, anchorLeft, sideKey) {
            rows.forEach(function (r) {
                var g = svg('g', { class: 'fl-node' + (state.ns === r.group ? ' on' : ''), tabindex: r.group === 'other' ? -1 : 0, role: 'button' });
                g.dataset.key = sideKey + r.group;
                g.dataset.group = r.group;
                var fill = r.group === 'other' ? 'var(--k-other)' : colorOf(r.group);
                var rect = svg('rect', { x: x, y: r.y.toFixed(1), width: nodeW, height: r.h.toFixed(1), rx: 3 });
                rect.style.fill = fill;
                g.appendChild(rect);
                var name = r.group === 'other' ? plural(r.members.length, 'other') : groupLabel(r.group);
                var tx = anchorLeft ? x - 10 : x + nodeW + 10;
                var cy = r.y + r.h / 2;
                var label = svg('text', { x: tx, y: (cy - 1).toFixed(1), class: 'fl-label', 'text-anchor': anchorLeft ? 'end' : 'start' });
                label.textContent = trim(name, labelMax);
                var sub = svg('text', { x: tx, y: (cy + 12).toFixed(1), class: 'fl-sub', 'text-anchor': anchorLeft ? 'end' : 'start' });
                sub.textContent = count(r.value) + ' · ' + share(r.value, total);
                add(g, label, sub);
                var t = svg('title');
                t.textContent = (r.group === 'other' ? r.members.map(groupLabel).join(', ') : name) + ' — ' + plural(r.value, 'flow') + (anchorLeft ? ' out' : ' in');
                g.appendChild(t);
                root.appendChild(g);
            });
        }
        drawSide(left, xL, true, 'L');
        drawSide(right, xR, false, 'R');

        var wrap = el('div', 'fl-map');
        var captions = el('div', 'fl-map-captions');
        add(captions, el('span', '', 'From'), el('span', '', 'To'));
        add(wrap, captions, root);
        box.appendChild(wrap);

        var legend = el('div', 'fl-legend');
        add(legend, el('span', 'fl-key ok', 'allowed, in the source’s colour'), el('span', 'fl-key deny', 'denied'));
        if (state.ns) legend.appendChild(K.link('Show every namespace', function () {
            setNamespace(state.ns);
        }));
        box.appendChild(legend);
    }

    function focusMap(key) {
        var root = $('map').querySelector('svg.fl-sankey');
        if (!root) return;
        root.querySelectorAll('.lit').forEach(function (x) {
            x.classList.remove('lit');
        });
        root.classList.toggle('focusing', !!key);
        if (!key) return;
        var related = {};
        related[key] = true;
        root.querySelectorAll('.fl-ribbon').forEach(function (p) {
            if (p.dataset.a === key || p.dataset.b === key) {
                p.classList.add('lit');
                related[p.dataset.a] = true;
                related[p.dataset.b] = true;
            }
        });
        root.querySelectorAll('.fl-node').forEach(function (g) {
            if (related[g.dataset.key]) g.classList.add('lit');
        });
    }

    // ----- what is being denied ------------------------------------------------------------

    function deniedGroups(list) {
        var groups = {};
        list.forEach(function (f) {
            if (f.action !== 'Deny') return;
            var k = f.src.id + '>' + f.dst.id + ':' + f.port + '/' + f.proto;
            var g = groups[k];
            if (!g) {
                g = groups[k] = { key: k, src: f.src, dst: f.dst, port: f.port, proto: f.proto, decider: f.decider, flows: [], packets: 0, last: 0 };
            }
            g.flows.push(f);
            g.packets += f.packets;
            g.last = Math.max(g.last, f.end);
        });
        return Object.keys(groups)
            .map(function (k) {
                return groups[k];
            })
            .sort(function (a, b) {
                return b.flows.length - a.flows.length || b.packets - a.packets;
            });
    }

    function epLine(ep, className) {
        var node = el('span', 'fl-ep' + (className ? ' ' + className : ''));
        var d = el('i', 'dot');
        d.style.background = colorOf(ep.group);
        node.appendChild(d);
        if (ep.namespace) node.appendChild(el('span', 'fl-ep-ns', ep.namespace));
        var name = el('span', 'fl-ep-name', ep.display);
        if (ep.kind !== 'workload') name.classList.add('special');
        node.appendChild(name);
        node.title = (ep.namespace ? ep.namespace + '/' : '') + ep.display + (ep.labels.length ? '\n' + ep.labels.join('\n') : '');
        return node;
    }

    function portText(f) {
        if (!f.port) return f.proto || '';
        return f.port + (f.proto ? '/' + f.proto : '');
    }

    function drawDenied(list) {
        var box = $('denied');
        box.textContent = '';
        var groups = deniedGroups(list);
        var n = groups.reduce(function (s, g) {
            return s + g.flows.length;
        }, 0);
        var countChip = el('span', 'count ' + (n ? 'error' : 'muted'), count(n));
        box.appendChild(cardHead('shieldOff', 'What is being denied', null, countChip));
        if (!groups.length) {
            var ok = el('div', 'fl-all-clear');
            add(ok, K.icon('shieldCheck'), el('div', '', add(el('strong', '', 'Nothing was dropped'), el('p', 'faint small', 'No flow in this window met a Deny — from a rule, or from the end of a tier.'))));
            box.appendChild(ok);
            return;
        }
        var ul = el('div', 'fl-dlist');
        groups.slice(0, 8).forEach(function (g) {
            var b = K.button('', 'fl-drow', null, function () {
                select(g.flows[0]);
            });
            var path = el('div', 'fl-dpath');
            var arrow = el('span', 'fl-arrow');
            arrow.appendChild(K.icon('arrow'));
            add(path, epLine(g.src), arrow, epLine(g.dst), g.port || g.proto ? el('code', 'fl-port', portText(g)) : null);
            var why = el('div', 'fl-dwhy');
            if (g.decider) add(why, hitBadge(g.decider), el('span', '', hitLabel(g.decider)));
            else why.appendChild(el('span', 'faint', 'no policy trace'));
            why.appendChild(el('span', 'fl-dwhen faint', 'last ' + clock(g.last)));
            var num = el('span', 'fl-dnum', '×' + count(g.flows.length));
            num.title = plural(g.flows.length, 'flow') + ', ' + count(g.packets) + ' packets';
            add(b, add(el('div', 'fl-dmain'), path, why), num);
            ul.appendChild(b);
        });
        box.appendChild(ul);
        if (groups.length > 8 || state.action !== 'Deny') {
            var more = K.link(groups.length > 8 ? 'All ' + plural(groups.length, 'denied path') + ' in the table' : 'Only denied flows in the table', function () {
                state.action = 'Deny';
                state.limit = PAGE;
                writeHash();
                render();
                $('table').scrollIntoView({ block: 'start', behavior: 'smooth' });
            });
            box.appendChild(add(el('div', 'fl-more'), more));
        }
    }

    // ----- the timeline ---------------------------------------------------------------

    function drawTimeline(list) {
        var box = $('timeline');
        box.textContent = '';
        var w = windowOf(state.window);
        var BUCKETS = Math.max(4, Math.min(60, Math.round(w.seconds / 15)));
        var now = state.fetchedAt || Date.now();
        var from = now - w.seconds * 1000;
        var step = (w.seconds * 1000) / BUCKETS;
        var buckets = [];
        for (var i = 0; i < BUCKETS; i++) buckets.push({ ok: 0, pass: 0, deny: 0, at: from + i * step });
        list.forEach(function (f) {
            var t = f.end || f.start;
            var at = Math.floor((t - from) / step);
            at = Math.max(0, Math.min(BUCKETS - 1, at));
            var b = buckets[at];
            if (f.action === 'Deny') b.deny++;
            else if (f.action === 'Pass') b.pass++;
            else b.ok++;
        });
        var top = buckets.reduce(function (m, b) {
            return Math.max(m, b.ok + b.pass + b.deny);
        }, 0);

        var legend = el('div', 'fl-legend inline');
        add(legend, el('span', 'fl-key ok', 'allowed'), el('span', 'fl-key pass', 'passed'), el('span', 'fl-key deny', 'denied'));
        box.appendChild(cardHead('chart', 'Over the window', 'flows by when they ended', legend));

        var W = 960;
        var H = 96;
        var bw = W / BUCKETS;
        var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + (H + 18), class: 'fl-bars', preserveAspectRatio: 'none', role: 'img' });
        root.setAttribute('aria-label', 'Flows over the last ' + w.words);
        [0.5, 1].forEach(function (f) {
            root.appendChild(svg('line', { x1: 0, x2: W, y1: H - H * f, y2: H - H * f, class: 'ov-grid' }));
        });
        buckets.forEach(function (b, i) {
            var total = b.ok + b.pass + b.deny;
            var g = svg('g', { class: 'fl-bar' });
            var y = H;
            [
                ['ok', b.ok],
                ['pass', b.pass],
                ['deny', b.deny],
            ].forEach(function (part) {
                if (!part[1] || !top) return;
                var h = Math.max(1.5, (part[1] / top) * (H - 4));
                y -= h;
                g.appendChild(svg('rect', { x: (i * bw + 1).toFixed(1), y: y.toFixed(1), width: Math.max(1, bw - 2).toFixed(1), height: h.toFixed(1), class: part[0] }));
            });
            g.appendChild(svg('rect', { x: (i * bw).toFixed(1), y: 0, width: bw.toFixed(1), height: H, class: 'hit' }));
            var t = svg('title');
            t.textContent = clock(b.at) + '–' + clock(b.at + step) + ': ' + (total ? plural(total, 'flow') + ' · ' + b.ok + ' allowed' + (b.pass ? ' · ' + b.pass + ' passed' : '') + ' · ' + b.deny + ' denied' : 'no flows');
            g.appendChild(t);
            root.appendChild(g);
        });
        [
            [0, 'start', clock(from)],
            [W / 2, 'middle', clock(from + (w.seconds * 1000) / 2)],
            [W, 'end', 'now'],
        ].forEach(function (a) {
            var t = svg('text', { x: a[0], y: H + 14, class: 'fl-axis', 'text-anchor': a[1] });
            t.textContent = a[2];
            root.appendChild(t);
        });
        var top2 = svg('text', { x: 4, y: 10, class: 'fl-axis' });
        top2.textContent = top ? String(top) : '';
        root.appendChild(top2);
        box.appendChild(add(el('div', 'fl-bars-wrap'), root));
    }

    // ----- the table ------------------------------------------------------------------

    function trail(f) {
        var node = el('span', 'fl-trail');
        var shown = f.enforced.slice(-2);
        if (!shown.length) {
            node.appendChild(el('span', 'faint', '—'));
            return node;
        }
        if (f.enforced.length > shown.length) node.appendChild(el('span', 'fl-trail-more', '+' + (f.enforced.length - shown.length)));
        shown.forEach(function (h, i) {
            if (i) node.appendChild(el('span', 'fl-trail-sep', '›'));
            var step = el('span', 'fl-step ' + (h.action || '').toLowerCase());
            add(step, el('span', 'fl-step-tier', h.tier || (h.kind === 'Profile' ? 'profile' : '·')), el('span', 'fl-step-name', h.kind === 'EndOfTier' ? 'end of tier' : h.kind === 'Profile' ? h.name.replace(/^k(ns|sa)\./, '') : h.name));
            step.title = hitLabel(h) + ' — ' + (h.action || '?') + (h.tier ? ' in tier ' + h.tier : '');
            node.appendChild(step);
        });
        if (f.pending.length && decider(f.pending) && decider(f.pending).action !== f.action) {
            var st = el('span', 'kbadge k-staged', 'staged: ' + decider(f.pending).action);
            st.title = 'With staged policies, this flow would be ' + decider(f.pending).action.toLowerCase();
            node.appendChild(st);
        }
        return node;
    }

    function drawTable(list) {
        var box = $('table');
        box.textContent = '';
        var n = byAction(list);
        var shownList = state.action
            ? list.filter(function (f) {
                  return f.action === state.action;
              })
            : list;

        box.appendChild(
            cardHead(
                'log',
                'Flows',
                count(shownList.length) + (shownList.length === 1 ? ' flow' : ' flows') + (state.action || state.ns || state.query ? ' shown of ' + count((state.flows || []).length) : ''),
                K.iconButton('repeat', 'Ask Whisker now', function () {
                    refresh();
                }),
            ),
        );

        var bar = el('div', 'filters fl-filters');
        bar.appendChild(el('span', 'filter-label', 'Verdict'));
        [
            ['', 'All', list.length],
            ['Allow', 'Allowed', n.Allow],
            ['Deny', 'Denied', n.Deny],
            ['Pass', 'Passed', n.Pass],
        ].forEach(function (a) {
            if (a[0] === 'Pass' && !a[2]) return;
            var b = K.button('', 'fchip' + (state.action === a[0] ? ' on' : ''), a[0] ? { Allow: 'allow', Deny: 'deny', Pass: 'pass' }[a[0]] : 'flows', function () {
                if (a[0] === '') {
                    state.action = '';
                    state.limit = PAGE;
                    writeHash();
                    render();
                } else setAction(a[0]);
            });
            add(b, el('span', '', a[1]), el('span', 'fchip-n', count(a[2])));
            bar.appendChild(b);
        });
        bar.appendChild(el('span', 'filter-sep'));
        bar.appendChild(el('span', 'filter-label', 'Namespace'));
        var pick = el('select', 'picker');
        var groups = {};
        (state.flows || []).forEach(function (f) {
            groups[f.src.group] = true;
            groups[f.dst.group] = true;
        });
        if (state.ns) groups[state.ns] = true;
        var optAll = el('option', '', 'Every namespace');
        optAll.value = '';
        pick.appendChild(optAll);
        Object.keys(groups)
            .sort(function (a, b) {
                var sa = a.indexOf('ns:') === 0 ? 0 : 1;
                var sb = b.indexOf('ns:') === 0 ? 0 : 1;
                return sa - sb || (groupLabel(a) < groupLabel(b) ? -1 : 1);
            })
            .forEach(function (g) {
                var o = el('option', '', groupLabel(g));
                o.value = g;
                if (g === state.ns) o.selected = true;
                pick.appendChild(o);
            });
        pick.addEventListener('change', function () {
            state.ns = pick.value;
            state.limit = PAGE;
            writeHash();
            render();
        });
        bar.appendChild(pick);
        if (state.query) {
            bar.appendChild(el('span', 'filter-sep'));
            bar.appendChild(K.chip('“' + state.query + '”', 'info', 'search'));
            bar.appendChild(
                K.link('clear', function () {
                    state.query = '';
                    $('query').value = '';
                    writeHash();
                    render();
                }),
            );
        }
        box.appendChild(bar);

        if (!shownList.length) {
            box.appendChild(el('p', 'quiet', (state.flows || []).length ? 'No flow matches these filters.' : 'No flows in this window.'));
            return;
        }

        var scroller = el('div', 'fl-table-wrap');
        var table = el('table', 'fl-table');
        var head = el('thead');
        var hr = el('tr');
        ['Ended', 'Verdict', 'Source', '', 'Destination', 'Port', 'Decided by', 'Traffic'].forEach(function (t, i) {
            var th = el('th', i === 7 ? 'num' : '', t);
            hr.appendChild(th);
        });
        head.appendChild(hr);
        table.appendChild(head);
        var body = el('tbody');
        shownList.slice(0, state.limit).forEach(function (f) {
            var tr = el('tr', 'fl-row' + (f.key === state.selected ? ' sel' : '') + (f.action === 'Deny' ? ' denied' : ''));
            tr.tabIndex = 0;
            tr.dataset.key = f.key;
            var arrow = el('td', 'fl-arrow-cell');
            arrow.appendChild(K.icon('arrow'));
            var traffic = el('td', 'num');
            add(traffic, el('span', '', bytes(f.bytes)), el('span', 'faint small', ' · ' + count(f.packets) + ' pkt'));
            add(
                tr,
                add(el('td', 'fl-time mono'), clock(f.end)),
                add(el('td'), K.actionPill(f.action, true)),
                add(el('td', 'fl-ep-cell'), epLine(f.src)),
                arrow,
                add(el('td', 'fl-ep-cell'), epLine(f.dst)),
                add(el('td', 'mono'), portText(f) || '—'),
                add(el('td'), trail(f)),
                traffic,
            );
            body.appendChild(tr);
        });
        table.appendChild(body);
        scroller.appendChild(table);
        box.appendChild(scroller);
        if (shownList.length > state.limit) {
            box.appendChild(
                add(
                    el('div', 'fl-more'),
                    K.button('Show ' + Math.min(PAGE, shownList.length - state.limit) + ' more', 'ghost small', 'down', function () {
                        state.limit += PAGE;
                        drawTable(scoped());
                    }),
                    el('span', 'faint small', count(shownList.length - state.limit) + ' not shown'),
                ),
            );
        }
    }

    // ----- the drawer ------------------------------------------------------------------

    function dsec(title, body, extra) {
        var node = el('section', 'dsec');
        var h = el('h3', 'mini-title', title);
        if (extra) h.appendChild(extra);
        node.appendChild(h);
        add(node, body);
        return node;
    }

    function endBox(ep, role) {
        var box = el('div', 'fl-end');
        var top = el('div', 'fl-end-head');
        var d = el('i', 'dot');
        d.style.background = colorOf(ep.group);
        add(top, el('span', 'mini-title', role), d, el('span', 'faint small', ep.namespace || groupLabel(ep.group)));
        box.appendChild(top);
        box.appendChild(el('div', 'fl-end-name', ep.display));
        var kindText = { workload: /\*$/.test(ep.name) ? 'pods that share this name' : 'a pod', public: 'addresses outside every network set, on the public internet', private: 'private addresses outside every network set', global: 'a host endpoint or a global network set' }[ep.kind];
        box.appendChild(el('div', 'faint small', kindText));
        if (ep.labels.length) {
            var labels = el('div', 'fl-labels');
            ep.labels.slice(0, 14).forEach(function (l) {
                labels.appendChild(el('code', 'label-chip', l));
            });
            if (ep.labels.length > 14) labels.appendChild(el('span', 'faint small', '+' + (ep.labels.length - 14)));
            box.appendChild(labels);
        }
        var pods = podsOf(ep);
        if (pods.length) {
            var list = el('div', 'wl-list');
            pods.slice(0, 6).forEach(function (p) {
                var b = K.button('', 'wl', null, function () {
                    open(C.podRef(p.obj));
                });
                add(b, K.sdot(p.ready ? 'ok' : p.phase === 'Pending' ? 'warn' : 'error'), el('span', '', p.name));
                b.title = p.namespace + '/' + p.name + (p.node ? ' on ' + p.node : '') + (p.ips.length ? ' · ' + p.ips.join(', ') : '');
                list.appendChild(b);
            });
            if (pods.length > 6) list.appendChild(el('span', 'faint small', 'and ' + (pods.length - 6) + ' more'));
            box.appendChild(list);
        } else if (ep.kind === 'workload' && state.model && state.model.podsKnown) {
            box.appendChild(el('p', 'faint small', 'No such pod runs now.'));
        }
        return box;
    }

    function traceList(list, flowAction) {
        var ol = el('ol', 'fl-trace');
        if (!list.length) {
            ol.appendChild(el('li', 'rule-none', 'No policy trace — the flow was decided before any policy, or Felix did not report one.'));
            return ol;
        }
        list.forEach(function (h, i) {
            var li = el('li', 'fl-hit ' + (h.action || '').toLowerCase() + (i === list.length - 1 ? ' last' : ''));
            var top = el('div', 'fl-hit-top');
            add(top, el('span', 'rule-n', String(i + 1)), h.tier ? K.chip(h.tier, 'outline', 'tier', 'Tier') : null, hitBadge(h));
            var ref = refOf(h);
            var name = ref
                ? K.link(h.kind === 'EndOfTier' ? 'end of tier' : hitLabel(h), function () {
                      open(ref);
                  }, 'Open ' + hitLabel(h))
                : el('span', 'fl-hit-name', h.kind === 'EndOfTier' ? 'end of tier ' + h.tier : hitLabel(h));
            top.appendChild(name);
            if (h.action) top.appendChild(K.actionPill(h.action, true));
            li.appendChild(top);

            var says = '';
            if (h.kind === 'EndOfTier') {
                says = 'No rule in tier ' + h.tier + ' matched, so the tier’s default action applied' + (h.trigger ? ' — ' + hitLabel(h.trigger) + ' selected this traffic' : '') + '.';
            } else if (h.kind === 'Profile') {
                says = 'Past every tier, the ' + hitLabel(h) + ' decided.';
            } else if (h.ruleIndex >= 0) {
                says = 'Rule ' + (h.ruleIndex + 1) + ' ' + ({ Allow: 'allowed it', Deny: 'denied it', Pass: 'passed it to the next tier', Log: 'logged it' }[h.action] || 'matched') + '.';
                var pol = policyOf(h);
                if (pol) {
                    // Which direction the rule is in is not reported; show it
                    // when only one direction has that many rules.
                    var inRule = pol.rulesIn[h.ruleIndex];
                    var outRule = pol.rulesOut[h.ruleIndex];
                    var only = inRule && !outRule ? inRule : outRule && !inRule ? outRule : null;
                    if (only && only.sentence) says += ' ' + only.sentence;
                }
            }
            if (says) li.appendChild(el('p', 'rule-says', says));
            ol.appendChild(li);
        });
        var last = list[list.length - 1];
        if (last && last.action && flowAction && last.action !== flowAction && last.action !== 'Pass') {
            ol.appendChild(el('li', 'rule-none', 'The flow was ' + flowAction.toLowerCase() + ', though the last step reads ' + last.action.toLowerCase() + '.'));
        }
        return ol;
    }

    function drawDrawer() {
        var box = $('drawer');
        var f = state.selectedFlow;
        document.body.classList.toggle('drawer-open', !!f);
        if (!f) {
            box.hidden = true;
            box.textContent = '';
            return;
        }
        var scroll = box.scrollTop;
        box.textContent = '';
        box.hidden = false;

        var top = el('div', 'd-top');
        add(
            top,
            K.actionPill(f.action),
            el('span', 'faint small', clock(f.start) + ' – ' + clock(f.end)),
            add(
                el('div', 'd-tools'),
                K.iconButton('close', 'Close', function () {
                    select(null);
                }),
            ),
        );
        box.appendChild(top);

        var title = el('h2', 'd-title fl-d-title');
        var arrow = el('span', 'fl-arrow');
        arrow.appendChild(K.icon('arrow'));
        add(title, el('span', '', f.src.display), arrow, el('span', '', f.dst.display));
        box.appendChild(title);
        var sub = el('div', 'd-sub');
        add(
            sub,
            f.port || f.proto ? K.chip(portText(f), 'info', 'api') : null,
            K.chip(f.reporter === 'Src' ? 'reported at the source' : f.reporter === 'Dst' ? 'reported at the destination' : 'reporter unknown', 'outline', 'eye'),
            f.decider ? add(el('span', ''), 'by ', el('strong', '', hitLabel(f.decider))) : null,
        );
        box.appendChild(sub);

        var ends = el('div', 'fl-ends');
        var mid = el('div', 'fl-ends-arrow');
        mid.appendChild(K.icon('arrow'));
        add(ends, endBox(f.src, 'From'), mid, endBox(f.dst, 'To'));
        box.appendChild(dsec('Endpoints', ends));

        box.appendChild(dsec('Policy trace', traceList(f.enforced, f.action), el('span', 'count muted', String(f.enforced.length))));
        var pendingDiffers = f.pending.length && JSON.stringify(f.pending) !== JSON.stringify(f.enforced);
        if (pendingDiffers) {
            var pd = decider(f.pending);
            var note = el('p', 'insp-note', pd && pd.action !== f.action ? 'With staged policies enforced, this flow would be ' + pd.action.toLowerCase() + ' instead.' : 'Staged policies change the path, not the verdict.');
            box.appendChild(dsec('With staged policies', [note, traceList(f.pending, pd ? pd.action : '')]));
        }

        var facts = el('dl', 'facts');
        [
            ['Protocol', f.proto || '—'],
            ['Port', f.port ? String(f.port) : '—'],
            ['Packets', count(f.packetsOut) + ' out · ' + count(f.packetsIn) + ' in'],
            ['Bytes', bytes(f.bytesOut) + ' out · ' + bytes(f.bytesIn) + ' in'],
            ['Window', clock(f.start) + ' – ' + clock(f.end) + ' · ' + Math.max(0, Math.round((f.end - f.start) / 1000)) + ' s'],
            ['From Whisker', state.answeredBy || '—'],
        ].forEach(function (kv) {
            add(facts, el('dt', '', kv[0]), el('dd', '', kv[1]));
        });
        box.appendChild(dsec('Traffic', facts));

        var actions = el('div', 'fl-actions left');
        if (f.src.kind === 'workload')
            actions.appendChild(
                K.button('Flows of ' + f.src.namespace, 'ghost small', 'filter', function () {
                    state.ns = f.src.group;
                    writeHash();
                    render();
                }),
            );
        if (f.dst.kind === 'workload' && f.dst.group !== f.src.group)
            actions.appendChild(
                K.button('Flows of ' + f.dst.namespace, 'ghost small', 'filter', function () {
                    state.ns = f.dst.group;
                    writeHash();
                    render();
                }),
            );
        actions.appendChild(
            K.button('Policy board', 'ghost small', 'lanes', function () {
                sdk.openView('policies').catch(fail);
            }),
        );
        box.appendChild(actions);
        box.scrollTop = scroll;
    }

    // ----- putting it together -----------------------------------------------------------

    function render() {
        drawWhere();
        drawTop();
        var m = state.model;
        if (!m) return;
        $('query').parentNode.hidden = !m.installed;
        if (!m.installed) {
            showEmpty(K.absent(sdk, state.ctx, m, state.summary, fail));
            select(null);
            return;
        }
        if (!sdk.services) return drawNoServices();
        if (whiskerAbsent(m)) {
            select(null);
            return drawNoWhisker(m);
        }
        if (!state.flows) {
            if (state.problem) return drawProblem(m, state.problem);
            showEmpty(emptyBox('flows', 'Asking Whisker…', 'Flows from the last ' + windowOf(state.window).words + ', through the API server.'));
            return;
        }
        if (state.problem && state.problem.kind !== 'too-big' && Date.now() - state.fetchedAt > 5 * 60000) {
            // What was read is too old to show as it is.
            return drawProblem(m, state.problem);
        }
        $('empty').hidden = true;
        $('flows').hidden = false;
        if (state.problem) {
            state.error = 'Showing what Whisker said ' + K.ago(state.fetchedAt) + ': ' + state.problem.message;
            drawError();
        } else if (/^Showing what Whisker said/.test(state.error)) {
            state.error = '';
            drawError();
        }
        var list = scoped();
        drawLede(list, state.flows);
        drawStats(list);
        drawMap(list);
        drawDenied(list);
        drawTimeline(list);
        drawTable(list);
        drawDrawer();
    }

    // ----- wiring --------------------------------------------------------------------------

    var map = $('map');
    map.addEventListener('pointerover', function (event) {
        var g = event.target.closest && event.target.closest('[data-key]');
        focusMap(g ? g.dataset.key : '');
    });
    map.addEventListener('pointerleave', function () {
        focusMap('');
    });
    map.addEventListener('click', function (event) {
        var g = event.target.closest && event.target.closest('.fl-node');
        if (g && g.dataset.group !== 'other') setNamespace(g.dataset.group);
    });
    map.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        var g = event.target.closest && event.target.closest('.fl-node');
        if (g && g.dataset.group !== 'other') {
            event.preventDefault();
            setNamespace(g.dataset.group);
        }
    });

    if (typeof ResizeObserver === 'function') {
        var resizing = 0;
        new ResizeObserver(function () {
            clearTimeout(resizing);
            resizing = setTimeout(function () {
                if (!state.flows || $('flows').hidden || !state.mapWidth) return;
                if (Math.abs(Math.round(map.clientWidth - 38) - state.mapWidth) > 24) drawMap(scoped());
            }, 120);
        }).observe(map);
    }

    var table = $('table');
    function rowFlow(tr) {
        var key = tr.dataset.key;
        return (state.flows || []).filter(function (f) {
            return f.key === key;
        })[0];
    }
    table.addEventListener('click', function (event) {
        var tr = event.target.closest && event.target.closest('tr.fl-row');
        if (!tr) return;
        var f = rowFlow(tr);
        select(f && f.key !== state.selected ? f : null);
        table.querySelectorAll('tr.fl-row').forEach(function (r) {
            r.classList.toggle('sel', r.dataset.key === state.selected);
        });
    });
    table.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        var tr = event.target.closest && event.target.closest('tr.fl-row');
        if (!tr) return;
        event.preventDefault();
        tr.click();
    });

    var queryTimer = 0;
    $('query').addEventListener('input', function (event) {
        clearTimeout(queryTimer);
        queryTimer = setTimeout(function () {
            state.query = event.target.value;
            state.limit = PAGE;
            writeHash();
            render();
        }, 160);
    });
    $('scrim').addEventListener('click', function () {
        select(null);
    });
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && state.selected) select(null);
    });
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && state.live && state.fetchedAt && Date.now() - state.fetchedAt > FLOW_POLL) refresh();
    });
    setInterval(drawWhere, 5000);

    $('logo').appendChild(K.logo());
    $('search-icon').appendChild(K.icon('search'));
    var liveButton = K.button('', 'ghost fl-live', null, function () {
        state.live = !state.live;
        writeHash();
        render();
        if (state.live) refresh();
    });
    liveButton.id = 'live';
    $('top-actions').appendChild(liveButton);
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

    readHash();
    $('query').value = state.query;
    drawTop();
    document.body.appendChild(
        K.grip({
            panel: $('drawer'),
            prop: '--drawer-w',
            className: 'drawer-grip',
            min: 380,
            room: 360,
            initial: state.width,
            label: 'Resize the flow panel',
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
            drawWhere();
            return K.store.get(sdk, STORE_KEY).then(function (id) {
                if (id === 'whisker' || id === 'whisker-tls') state.remembered = id;
                modelLoop();
                sdk.summary()
                    .then(function (s) {
                        state.summary = s;
                        if (state.model && !state.model.installed) render();
                    })
                    .catch(function () {});
            });
        })
        .catch(fail);
})();
