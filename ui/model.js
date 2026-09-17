// The Calico model every page of this plugin draws from: the IP pools and the
// IPAM blocks carved from them, which pod holds which address, the nodes and
// how they peer, every policy in the tier and order Calico evaluates it in,
// and which workloads each one selects. Read once per poll through the
// k8sdockside bridge and worked out here, so the pages only have to draw.
//
// Everything is read from the crd.projectcalico.org/v1 objects every Calico
// install has, not the aggregated projectcalico.org/v3 API, which needs the
// Calico API server. Addresses are BigInts: an IPv6 pool is as ordinary as an
// IPv4 one, and a /64 does not fit in a double.
(function () {
    'use strict';

    var S = window.CalicoSelector;
    var G = 'crd.projectcalico.org';
    var OP = 'operator.tigera.io';

    var KINDS = {
        pools: 'crd:ippools.' + G,
        blocks: 'crd:ipamblocks.' + G,
        affinities: 'crd:blockaffinities.' + G,
        felix: 'crd:felixconfigurations.' + G,
        nps: 'crd:networkpolicies.' + G,
        gnps: 'crd:globalnetworkpolicies.' + G,
        tiers: 'crd:tiers.' + G,
        snps: 'crd:stagednetworkpolicies.' + G,
        sgnps: 'crd:stagedglobalnetworkpolicies.' + G,
        sknps: 'crd:stagedkubernetesnetworkpolicies.' + G,
        bgpConfig: 'crd:bgpconfigurations.' + G,
        bgpPeers: 'crd:bgppeers.' + G,
        bgpFilters: 'crd:bgpfilters.' + G,
        nodeStatus: 'crd:caliconodestatuses.' + G,
        clusterInfo: 'crd:clusterinformations.' + G,
        ipamConfig: 'crd:ipamconfigs.' + G,
        ipamHandles: 'crd:ipamhandles.' + G,
        reservations: 'crd:ipreservations.' + G,
        netSets: 'crd:networksets.' + G,
        globalNetSets: 'crd:globalnetworksets.' + G,
        hostEndpoints: 'crd:hostendpoints.' + G,
        kcConfig: 'crd:kubecontrollersconfigurations.' + G,
        installations: 'crd:installations.' + OP,
        tigeraStatus: 'crd:tigerastatuses.' + OP,
        apiServers: 'crd:apiservers.' + OP,
        whiskers: 'crd:whiskers.' + OP,
        goldmanes: 'crd:goldmanes.' + OP,
        knps: 'networkpolicies',
        pods: 'pods',
        nodes: 'nodes',
        namespaces: 'namespaces',
        services: 'services',
        events: 'events',
    };

    // The policy kinds, as the pages name and badge them.
    var POLICY_KINDS = {
        np: { kind: KINDS.nps, badge: 'NP', label: 'Calico network policy', staged: false },
        gnp: { kind: KINDS.gnps, badge: 'GNP', label: 'Global network policy', staged: false },
        knp: { kind: KINDS.knps, badge: 'K8s', label: 'Kubernetes network policy', staged: false },
        snp: { kind: KINDS.snps, badge: 'NP', label: 'Staged network policy', staged: true },
        sgnp: { kind: KINDS.sgnps, badge: 'GNP', label: 'Staged global network policy', staged: true },
        sknp: { kind: KINDS.sknps, badge: 'K8s', label: 'Staged Kubernetes network policy', staged: true },
    };

    // Built-in tiers (libcalico-go names/policy.go, api v3 tier.go). Older
    // releases called the admin tiers adminnetworkpolicy and
    // baselineadminnetworkpolicy, at the same orders.
    var DEFAULT_TIER = 'default';
    var DEFAULT_TIER_ORDER = 1000000;
    var K8S_POLICY_ORDER = 1000;
    var BUILTIN_TIERS = {
        default: { order: 1000000, action: 'Deny' },
        'kube-admin': { order: 1000, action: 'Pass' },
        'kube-baseline': { order: 10000000, action: 'Pass' },
        adminnetworkpolicy: { order: 1000, action: 'Pass' },
        baselineadminnetworkpolicy: { order: 10000000, action: 'Pass' },
    };

    // The labels Calico adds to a pod's workload endpoint, and the prefixes it
    // gives the labels a pod inherits from its namespace and service account
    // (libcalico-go conversion + api v3 labels).
    var LABEL_NAMESPACE = 'projectcalico.org/namespace';
    var LABEL_ORCHESTRATOR = 'projectcalico.org/orchestrator';
    var LABEL_SERVICEACCOUNT = 'projectcalico.org/serviceaccount';
    var LABEL_NAME = 'projectcalico.org/name';

    // What calico-node writes on a Kubernetes Node (libcalico-go
    // backend/k8s/resources/node.go).
    var NODE_ANN = {
        ipv4: 'projectcalico.org/IPv4Address',
        ipv6: 'projectcalico.org/IPv6Address',
        ipip: 'projectcalico.org/IPv4IPIPTunnelAddr',
        vxlan: 'projectcalico.org/IPv4VXLANTunnelAddr',
        vxlan6: 'projectcalico.org/IPv6VXLANTunnelAddr',
        wg: 'projectcalico.org/IPv4WireguardInterfaceAddr',
        wg6: 'projectcalico.org/IPv6WireguardInterfaceAddr',
        wgKey: 'projectcalico.org/WireguardPublicKey',
        wgKey6: 'projectcalico.org/WireguardPublicKeyV6',
        asn: 'projectcalico.org/ASNumber',
        rr: 'projectcalico.org/RouteReflectorClusterID',
    };

    // Calico's own pods. The operator and the manifests both label them
    // k8s-app=<name>; the operator's API server is also apiserver=true.
    var COMPONENTS = [
        { id: 'node', label: 'calico-node', app: 'calico-node', view: 'calico-node' },
        { id: 'controllers', label: 'kube-controllers', app: 'calico-kube-controllers', view: 'kube-controllers' },
        { id: 'typha', label: 'Typha', app: 'calico-typha', view: 'typha' },
        { id: 'apiserver', label: 'API server', app: 'calico-apiserver', view: 'apiserver' },
        { id: 'whisker', label: 'Whisker', app: 'whisker', view: '' },
        { id: 'goldmane', label: 'Goldmane', app: 'goldmane', view: '' },
    ];
    var CALICO_NAMESPACES = ['calico-system', 'calico-apiserver', 'tigera-operator', 'tigera-system'];
    var SYSTEM_NAMESPACES = ['kube-system', 'kube-public', 'kube-node-lease'].concat(CALICO_NAMESPACES);

    // The IPAM attribute keys (libcalico-go backend/model/block.go).
    var TUNNEL_TYPES = {
        ipipTunnelAddress: 'IPIP tunnel',
        vxlanTunnelAddress: 'VXLAN tunnel',
        vxlanV6TunnelAddress: 'VXLAN tunnel',
        wireguardTunnelAddress: 'WireGuard',
        wireguardV6TunnelAddress: 'WireGuard',
    };

    var FALLBACK_CHART = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
    // The chart series, less the sixth: it is a second green, too close to
    // the third to tell two namespaces apart by.
    var SERIES = [0, 1, 2, 3, 4, 6, 7];
    var PALETTE = SERIES.length;

    function chartColor(i) {
        var n = SERIES[Math.min(i, SERIES.length - 1)];
        return 'var(--chart-' + (n + 1) + ', ' + FALLBACK_CHART[n] + ')';
    }
    var OTHER_COLOR = 'var(--k-other)';

    // ----- addresses ---------------------------------------------------------

    function parseIPv4(text) {
        var parts = text.split('.');
        if (parts.length !== 4) return null;
        var n = 0n;
        for (var i = 0; i < 4; i++) {
            if (!/^\d{1,3}$/.test(parts[i])) return null;
            var octet = Number(parts[i]);
            if (octet > 255) return null;
            n = n * 256n + BigInt(octet);
        }
        return { v: 4, n: n };
    }

    function parseIPv6(text) {
        var zone = text.indexOf('%');
        if (zone >= 0) text = text.slice(0, zone);
        var lastColon = text.lastIndexOf(':');
        if (lastColon >= 0 && text.indexOf('.', lastColon) > lastColon) {
            var v4 = parseIPv4(text.slice(lastColon + 1));
            if (!v4) return null;
            text = text.slice(0, lastColon + 1) + Number(v4.n >> 16n).toString(16) + ':' + Number(v4.n & 0xffffn).toString(16);
        }
        var halves = text.split('::');
        if (halves.length > 2) return null;
        var head = halves[0] ? halves[0].split(':') : [];
        var tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
        var missing = 8 - head.length - tail.length;
        if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
        var groups = head.concat(new Array(halves.length === 2 ? missing : 0).fill('0'), tail);
        var n = 0n;
        for (var i = 0; i < groups.length; i++) {
            if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
            n = (n << 16n) + BigInt(parseInt(groups[i], 16));
        }
        return { v: 6, n: n };
    }

    function parseIP(text) {
        text = String(text || '').trim();
        if (!text) return null;
        return text.indexOf(':') >= 0 ? parseIPv6(text) : parseIPv4(text);
    }

    function formatIP(ip) {
        if (ip.v === 4) {
            var out = [];
            for (var shift = 24n; shift >= 0n; shift -= 8n) out.push(Number((ip.n >> shift) & 255n));
            return out.join('.');
        }
        var groups = [];
        for (var s = 112n; s >= 0n; s -= 16n) groups.push(Number((ip.n >> s) & 0xffffn));
        var best = -1;
        var bestLen = 1;
        for (var i = 0; i < 8; ) {
            if (groups[i] !== 0) {
                i++;
                continue;
            }
            var j = i;
            while (j < 8 && groups[j] === 0) j++;
            if (j - i > bestLen) {
                best = i;
                bestLen = j - i;
            }
            i = j;
        }
        var hex = groups.map(function (g) {
            return g.toString(16);
        });
        if (best < 0) return hex.join(':');
        return hex.slice(0, best).join(':') + '::' + hex.slice(best + bestLen).join(':');
    }

    function ipKey(ip) {
        return ip.v + ':' + ip.n.toString(16);
    }

    function keyToIP(key) {
        var cut = key.indexOf(':');
        return { v: Number(key.slice(0, cut)), n: BigInt('0x' + key.slice(cut + 1)) };
    }

    // "10.244.0.0/16" -> { v, base, prefix, bits, size, text }. A host part
    // left set is masked off, as Calico does.
    function parseCIDR(text) {
        text = String(text || '').trim();
        var cut = text.split('/');
        var ip = parseIP(cut[0]);
        if (!ip || cut.length !== 2 || !/^\d{1,3}$/.test(cut[1])) return null;
        var width = ip.v === 4 ? 32 : 128;
        var prefix = Number(cut[1]);
        if (prefix > width) return null;
        var host = BigInt(width - prefix);
        var base = (ip.n >> host) << host;
        return { v: ip.v, base: base, prefix: prefix, width: width, size: 1n << host, text: formatIP({ v: ip.v, n: base }) + '/' + prefix };
    }

    function cidrHas(net, ip) {
        return !!net && !!ip && net.v === ip.v && ip.n >= net.base && ip.n < net.base + net.size;
    }

    function cidrInside(inner, outer) {
        return !!inner && !!outer && inner.v === outer.v && inner.prefix >= outer.prefix && inner.base >= outer.base && inner.base + inner.size <= outer.base + outer.size;
    }

    function stripMask(text) {
        return String(text || '').split('/')[0];
    }

    // ----- small readers -----------------------------------------------------

    function dig(obj, path) {
        var at = obj;
        var keys = path.split('.');
        for (var i = 0; i < keys.length; i++) {
            if (at === null || at === undefined) return undefined;
            at = at[keys[i]];
        }
        return at;
    }

    function labelsOf(obj) {
        return (obj && obj.metadata && obj.metadata.labels) || {};
    }

    function annotationsOf(obj) {
        return (obj && obj.metadata && obj.metadata.annotations) || {};
    }

    function condition(obj, type) {
        var list = dig(obj, 'status.conditions') || [];
        for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
        return null;
    }

    function conditionTrue(obj, type) {
        var c = condition(obj, type);
        return !!c && c.status === 'True';
    }

    function podReady(pod) {
        return dig(pod, 'status.phase') === 'Running' && conditionTrue(pod, 'Ready');
    }

    function restarts(pod) {
        return (dig(pod, 'status.containerStatuses') || []).reduce(function (n, c) {
            return n + (c.restartCount || 0);
        }, 0);
    }

    function envOf(pod, container, name) {
        var list = dig(pod, 'spec.containers') || [];
        for (var i = 0; i < list.length; i++) {
            if (container && list[i].name !== container) continue;
            var env = list[i].env || [];
            for (var j = 0; j < env.length; j++) {
                if (env[j].name === name) return env[j].value !== undefined ? env[j].value : null;
            }
        }
        return undefined;
    }

    // "quay.io/calico/node:v3.30.2" -> "v3.30.2".
    function imageTag(pod, match) {
        var containers = dig(pod, 'spec.containers') || [];
        for (var i = 0; i < containers.length; i++) {
            var image = containers[i].image || '';
            var at = image.lastIndexOf(':');
            if (at > image.lastIndexOf('/') && (!match || image.indexOf(match) >= 0)) return image.slice(at + 1).replace(/@.*$/, '');
        }
        return '';
    }

    // crd.projectcalico.org objects keep their v3 metadata -- the name a
    // policy was created with, and its labels -- in an annotation
    // (libcalico-go backend/k8s/resources/resources.go).
    function calicoMeta(obj) {
        var raw = annotationsOf(obj)['projectcalico.org/metadata'];
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    function calicoLabels(obj) {
        var meta = calicoMeta(obj);
        if (meta && meta.labels) return meta.labels;
        var raw = annotationsOf(obj)['projectcalico.org/labels'];
        if (raw) {
            try {
                return JSON.parse(raw) || {};
            } catch (e) {
                // fall through
            }
        }
        return labelsOf(obj);
    }

    function soft(promise) {
        return promise.then(
            function (items) {
                return { ok: true, items: items || [], error: '' };
            },
            function (err) {
                return { ok: false, items: [], error: (err && err.message) || String(err) };
            },
        );
    }

    function version(list) {
        return list
            .map(function (o) {
                return (o.metadata && o.metadata.uid) + '@' + (o.metadata && o.metadata.resourceVersion);
            })
            .join(',');
    }

    function byName(a, b) {
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    }

    function plural(n, one, many) {
        return n + ' ' + (n === 1 ? one : many || one + 's');
    }

    function names(list, max) {
        max = max || 3;
        var shown = list.slice(0, max).map(function (n) {
            return typeof n === 'string' ? n : n.name;
        });
        if (list.length > max) shown.push(list.length - max + ' more');
        if (shown.length < 2) return shown.join('');
        return shown.slice(0, -1).join(', ') + ' and ' + shown[shown.length - 1];
    }

    // ----- reading -----------------------------------------------------------

    var READS = [
        'pools', 'blocks', 'affinities', 'felix', 'nps', 'gnps', 'tiers', 'snps', 'sgnps', 'sknps', 'knps',
        'bgpConfig', 'bgpPeers', 'bgpFilters', 'nodeStatus', 'clusterInfo', 'ipamConfig', 'reservations', 'hostEndpoints',
        'installations', 'tigeraStatus', 'apiServers', 'whiskers', 'goldmanes', 'nodes', 'namespaces', 'pods',
    ];

    // Reads everything the pages need, each kind on its own: a cluster
    // without the operator, the staged kinds or BGP still gets the rest.
    function load(sdk) {
        return Promise.all(
            READS.map(function (key) {
                return soft(sdk.list({ kind: KINDS[key], namespace: '' }));
            }),
        ).then(function (got) {
            var raw = {};
            READS.forEach(function (key, i) {
                raw[key] = got[i];
            });
            return build(raw);
        });
    }

    // ----- building ------------------------------------------------------------

    function build(raw) {
        var model = {
            installed: raw.pools.ok,
            missing: raw.pools.error,
            served: {},
            errors: {},
            sig: READS.map(function (k) {
                return raw[k].ok ? version(raw[k].items) : '!' + raw[k].error;
            }).join('|'),
            now: Date.now(),
        };
        READS.forEach(function (k) {
            model.served[k] = raw[k].ok;
            if (!raw[k].ok) model.errors[k] = raw[k].error;
        });

        buildPlatform(model, raw);
        buildNamespaces(model, raw);
        buildPods(model, raw);
        buildNodes(model, raw);
        buildIPAM(model, raw);
        buildBGP(model, raw);
        buildPolicies(model, raw);
        buildColors(model);
        model.findings = findings(model);
        return model;
    }

    // What Calico is and how it is set up: version, variant, dataplane, the
    // operator's view of it, Felix's configuration.
    function buildPlatform(model, raw) {
        var install = raw.installations.items.filter(function (i) {
            return i.metadata.name === 'default';
        })[0] || raw.installations.items[0] || null;
        var info = raw.clusterInfo.items.filter(function (i) {
            return i.metadata.name === 'default';
        })[0] || raw.clusterInfo.items[0] || null;
        var felix = raw.felix.items.filter(function (f) {
            return f.metadata.name === 'default';
        })[0] || null;
        var ipamConfig = raw.ipamConfig.items.filter(function (c) {
            return c.metadata.name === 'default';
        })[0] || raw.ipamConfig.items[0] || null;
        model.installation = install;
        model.clusterInfo = info;
        model.felixObj = felix;
        model.felixAll = raw.felix.items;
        model.ipamConfig = ipamConfig;
        model.operator = raw.installations.ok && !!install;

        var net = install ? dig(install, 'status.computed.calicoNetwork') || dig(install, 'spec.calicoNetwork') || {} : {};
        model.variant = (install && (dig(install, 'status.variant') || dig(install, 'spec.variant'))) || (info && dig(info, 'spec.variant')) || '';
        if (model.variant === 'TigeraSecureEnterprise') model.variant = 'CalicoEnterprise';
        model.version = (info && dig(info, 'spec.calicoVersion')) || (install && dig(install, 'status.calicoVersion')) || '';
        model.datastoreReady = info ? dig(info, 'spec.datastoreReady') !== false : null;
        model.clusterType = (info && dig(info, 'spec.clusterType')) || '';

        // The components, from the pods.
        model.components = {};
        COMPONENTS.forEach(function (c) {
            model.components[c.id] = { id: c.id, label: c.label, view: c.view, pods: [], ready: 0 };
        });
        raw.pods.items.forEach(function (pod) {
            var l = labelsOf(pod);
            var app = l['k8s-app'];
            var hit = null;
            COMPONENTS.forEach(function (c) {
                if (app === c.app) hit = c;
            });
            if (!hit && l.apiserver === 'true' && CALICO_NAMESPACES.indexOf(pod.metadata.namespace) >= 0) hit = COMPONENTS[3];
            if (!hit) return;
            var comp = model.components[hit.id];
            comp.pods.push(pod);
            if (podReady(pod)) comp.ready++;
        });
        var nodePods = model.components.node.pods;
        model.namespace = nodePods.length ? nodePods[0].metadata.namespace : install ? 'calico-system' : '';
        if (!model.version && nodePods.length) model.version = imageTag(nodePods[0], 'node');
        model.componentsKnown = nodePods.length > 0;

        // How calico-node was started, when the operator does not say.
        var backend = nodePods.length ? envOf(nodePods[0], 'calico-node', 'CALICO_NETWORKING_BACKEND') : undefined;
        model.backend = typeof backend === 'string' ? backend : '';

        // The dataplane: the operator's choice first, then Felix's own
        // configuration, then what calico-node was started with.
        var fspec = (felix && felix.spec) || {};
        var envBpf = nodePods.length ? envOf(nodePods[0], 'calico-node', 'FELIX_BPFENABLED') : undefined;
        var envNft = nodePods.length ? envOf(nodePods[0], 'calico-node', 'FELIX_NFTABLESMODE') : undefined;
        var dp = { id: 'iptables', label: 'iptables', source: 'default', known: false };
        var fromOperator = { Iptables: 'iptables', BPF: 'bpf', VPP: 'vpp', Nftables: 'nftables' }[net.linuxDataplane];
        if (fromOperator) dp = { id: fromOperator, source: 'Installation', known: true };
        else if (fspec.bpfEnabled === true || String(envBpf).toLowerCase() === 'true') dp = { id: 'bpf', source: fspec.bpfEnabled === true ? 'FelixConfiguration' : 'calico-node', known: true };
        else if (fspec.nftablesMode === 'Enabled' || String(envNft).toLowerCase() === 'enabled') dp = { id: 'nftables', source: 'FelixConfiguration', known: true };
        else if (felix) dp = { id: 'iptables', source: 'FelixConfiguration', known: true, auto: (fspec.nftablesMode || 'Auto') === 'Auto' };
        dp.label = { iptables: 'iptables', bpf: 'eBPF', nftables: 'nftables', vpp: 'VPP' }[dp.id];
        model.dataplane = dp;

        model.felix = {
            wireguard: fspec.wireguardEnabled === true,
            wireguardV6: fspec.wireguardEnabledV6 === true,
            wireguardHost: fspec.wireguardHostEncryptionEnabled === true,
            ipv6: fspec.ipv6Support,
            flowLogs: fspec.flowLogsGoldmaneServer || '',
            prometheus: fspec.prometheusMetricsEnabled === true,
            routeSource: fspec.routeSource || 'CalicoIPAM',
            bpfKubeProxy: fspec.bpfKubeProxyIptablesCleanupEnabled,
            mtu: fspec.vxlanMTU || fspec.ipipMTU || fspec.wireguardMTU || 0,
            logSeverity: fspec.logSeverityScreen || '',
        };
        model.mtu = (install && (dig(install, 'status.mtu') || net.mtu)) || model.felix.mtu || 0;
        model.bgpEnabled = net.bgp === 'Enabled' ? true : net.bgp === 'Disabled' ? false : model.backend === 'bird' ? true : model.backend === 'vxlan' || model.backend === 'none' ? false : null;
        model.flows = {
            whisker: raw.whiskers.items.length > 0 || model.components.whisker.pods.length > 0,
            goldmane: raw.goldmanes.items.length > 0 || model.components.goldmane.pods.length > 0,
            served: raw.whiskers.ok || raw.goldmanes.ok,
        };
        model.apiServer = {
            object: raw.apiServers.items[0] || null,
            pods: model.components.apiserver.pods.length,
            ready: model.components.apiserver.ready,
        };

        // The operator's own report, one entry per component.
        model.tigera = raw.tigeraStatus.items
            .map(function (s) {
                var avail = condition(s, 'Available');
                var prog = condition(s, 'Progressing');
                var deg = condition(s, 'Degraded');
                var tone = deg && deg.status === 'True' ? 'error' : prog && prog.status === 'True' ? 'info' : avail && avail.status === 'True' ? 'ok' : 'warn';
                return {
                    name: s.metadata.name,
                    obj: s,
                    tone: tone,
                    state: tone === 'error' ? 'Degraded' : tone === 'info' ? 'Progressing' : tone === 'ok' ? 'Available' : 'Unavailable',
                    message: (deg && deg.status === 'True' && deg.message) || (s.status && s.status.message) || (prog && prog.status === 'True' && prog.message) || '',
                    reason: (deg && deg.status === 'True' && deg.reason) || '',
                };
            })
            .sort(byName);
    }

    function isSystemNamespace(name) {
        return SYSTEM_NAMESPACES.indexOf(name) >= 0;
    }

    function buildNamespaces(model, raw) {
        model.namespaces = [];
        model.namespaceByName = {};
        raw.namespaces.items.forEach(function (ns) {
            var entry = {
                name: ns.metadata.name,
                obj: ns,
                labels: labelsOf(ns),
                system: isSystemNamespace(ns.metadata.name),
                pods: [],
                policies: [],
            };
            // What a namespaceSelector is evaluated against: the namespace's
            // labels, and projectcalico.org/name for its name.
            entry.selectorLabels = Object.assign({}, entry.labels);
            entry.selectorLabels[LABEL_NAME] = entry.name;
            model.namespaces.push(entry);
            model.namespaceByName[entry.name] = entry;
        });
        model.namespacesKnown = raw.namespaces.ok;
    }

    function namespaceEntry(model, name) {
        var entry = model.namespaceByName[name];
        if (!entry) {
            // Namespaces could not be read: one is made up from its pods, with
            // no labels but its name.
            var labels = { 'kubernetes.io/metadata.name': name };
            entry = { name: name, obj: null, labels: labels, system: isSystemNamespace(name), pods: [], policies: [], guessed: true };
            entry.selectorLabels = Object.assign({}, labels);
            entry.selectorLabels[LABEL_NAME] = name;
            model.namespaces.push(entry);
            model.namespaceByName[name] = entry;
        }
        return entry;
    }

    function buildPods(model, raw) {
        model.pods = [];
        model.podByKey = {};
        model.weps = [];
        raw.pods.items.forEach(function (obj) {
            var spec = obj.spec || {};
            var status = obj.status || {};
            var ns = obj.metadata.namespace;
            var phase = status.phase || 'Pending';
            var ips = (status.podIPs || []).map(function (p) {
                return p.ip;
            });
            if (!ips.length && status.podIP) ips = [status.podIP];
            var sa = spec.serviceAccountName || 'default';
            var labels = labelsOf(obj);
            var pod = {
                key: ns + '/' + obj.metadata.name,
                name: obj.metadata.name,
                namespace: ns,
                obj: obj,
                labels: labels,
                node: spec.nodeName || '',
                phase: phase,
                ready: podReady(obj),
                hostNetwork: spec.hostNetwork === true,
                serviceAccount: sa,
                ips: spec.hostNetwork ? [] : ips,
                // A workload endpoint: Calico's view of a pod on its network.
                wep: spec.hostNetwork !== true && phase !== 'Succeeded' && phase !== 'Failed',
                policies: [],
                staged: [],
                allocations: [],
            };
            // The labels Calico matches a policy's selector against.
            var sel = Object.assign({}, labels);
            sel[LABEL_NAMESPACE] = ns;
            sel[LABEL_ORCHESTRATOR] = 'k8s';
            if (sa.length < 63) sel[LABEL_SERVICEACCOUNT] = sa;
            pod.selectorLabels = sel;
            pod.saLabels = {};
            pod.saLabels[LABEL_NAME] = sa;
            model.pods.push(pod);
            model.podByKey[pod.key] = pod;
            var nsEntry = namespaceEntry(model, ns);
            if (pod.wep) {
                model.weps.push(pod);
                nsEntry.pods.push(pod);
            }
        });
        model.podsKnown = raw.pods.ok;
    }

    function buildNodes(model, raw) {
        var calicoOn = {};
        model.components.node.pods.forEach(function (pod) {
            if (pod.spec && pod.spec.nodeName) calicoOn[pod.spec.nodeName] = pod;
        });
        var statusFor = {};
        raw.nodeStatus.items.forEach(function (s) {
            var node = dig(s, 'spec.node');
            if (node) statusFor[node] = s;
        });
        model.nodeStatusServed = raw.nodeStatus.ok;
        model.nodeStatuses = raw.nodeStatus.items;
        model.nodes = raw.nodes.items
            .map(function (n) {
                var a = annotationsOf(n);
                var calico = calicoOn[n.metadata.name] || null;
                var st = statusFor[n.metadata.name] || null;
                var addresses = (dig(n, 'status.addresses') || []).filter(function (x) {
                    return x.type === 'InternalIP';
                });
                return {
                    name: n.metadata.name,
                    obj: n,
                    labels: labelsOf(n),
                    ready: conditionTrue(n, 'Ready'),
                    unschedulable: dig(n, 'spec.unschedulable') === true,
                    internalIPs: addresses.map(function (x) {
                        return x.address;
                    }),
                    ipv4: a[NODE_ANN.ipv4] || '',
                    ipv6: a[NODE_ANN.ipv6] || '',
                    ipip: a[NODE_ANN.ipip] || '',
                    vxlan: a[NODE_ANN.vxlan] || '',
                    vxlan6: a[NODE_ANN.vxlan6] || '',
                    wg: a[NODE_ANN.wg] || '',
                    wg6: a[NODE_ANN.wg6] || '',
                    wgKey: a[NODE_ANN.wgKey] || a[NODE_ANN.wgKey6] || '',
                    asn: a[NODE_ANN.asn] || '',
                    rr: a[NODE_ANN.rr] || '',
                    calico: calico,
                    calicoReady: !!calico && podReady(calico),
                    calicoRestarts: calico ? restarts(calico) : 0,
                    calicoPhase: calico ? dig(calico, 'status.phase') || 'Pending' : '',
                    status: st,
                    peers: st ? (dig(st, 'status.bgp.peersV4') || []).concat(dig(st, 'status.bgp.peersV6') || []) : null,
                    bird: st ? dig(st, 'status.agent.birdV4.state') || '' : '',
                    blocks: [],
                    pods: 0,
                    borrowed: 0,
                    used: 0,
                    capacity: 0,
                };
            })
            .sort(byName);
        model.nodeByName = {};
        model.nodeByIP = {};
        model.nodes.forEach(function (n) {
            model.nodeByName[n.name] = n;
            [n.ipv4, n.ipv6].concat(n.internalIPs).forEach(function (ip) {
                var parsed = parseIP(stripMask(ip));
                if (parsed) model.nodeByIP[ipKey(parsed)] = n;
            });
        });
        model.weps.forEach(function (p) {
            var n = model.nodeByName[p.node];
            if (n) n.pods++;
        });
        model.nodesKnown = raw.nodes.ok;
    }

    // ----- IPAM ----------------------------------------------------------------

    function encapOf(spec) {
        var ipip = spec.ipipMode || 'Never';
        var vxlan = spec.vxlanMode || 'Never';
        if (vxlan !== 'Never') return { id: 'vxlan', label: 'VXLAN', cross: vxlan === 'CrossSubnet', text: vxlan === 'CrossSubnet' ? 'VXLAN · CrossSubnet' : 'VXLAN' };
        if (ipip !== 'Never') return { id: 'ipip', label: 'IPIP', cross: ipip === 'CrossSubnet', text: ipip === 'CrossSubnet' ? 'IPIP · CrossSubnet' : 'IPIP' };
        return { id: 'none', label: 'None', cross: false, text: 'No encapsulation' };
    }

    function buildIPAM(model, raw) {
        model.pools = raw.pools.items
            .map(function (obj) {
                var spec = obj.spec || {};
                var net = parseCIDR(spec.cidr);
                var blockSize = spec.blockSize || (net && net.v === 6 ? 122 : 26);
                var poolSel = S.parse(spec.nodeSelector || 'all()');
                var nsSel = spec.namespaceSelector ? S.parse(spec.namespaceSelector) : null;
                var blockBits = net ? Math.max(0, blockSize - net.prefix) : 0;
                return {
                    name: obj.metadata.name,
                    obj: obj,
                    cidr: spec.cidr || '',
                    net: net,
                    v: net ? net.v : 0,
                    blockSize: blockSize,
                    blockAddresses: net ? 1n << BigInt(net.width - blockSize) : 0n,
                    possibleBlocks: net ? 1n << BigInt(blockBits) : 0n,
                    capacity: net ? net.size : 0n,
                    encap: encapOf(spec),
                    ipipMode: spec.ipipMode || 'Never',
                    vxlanMode: spec.vxlanMode || 'Never',
                    nat: spec.natOutgoing === true,
                    disabled: spec.disabled === true,
                    disableBGPExport: spec.disableBGPExport === true,
                    nodeSelector: spec.nodeSelector || '',
                    nodeSel: poolSel,
                    namespaceSelector: spec.namespaceSelector || '',
                    nsSel: nsSel,
                    allowedUses: spec.allowedUses && spec.allowedUses.length ? spec.allowedUses : ['Workload', 'Tunnel'],
                    assignmentMode: spec.assignmentMode || 'Automatic',
                    blocks: [],
                    used: 0,
                    borrowed: 0,
                    tunnels: 0,
                    reserved: [],
                    nodes: [],
                };
            })
            .sort(function (a, b) {
                return a.v - b.v || byName(a, b);
            });
        model.poolByName = {};
        model.pools.forEach(function (p) {
            model.poolByName[p.name] = p;
            p.nodes = model.nodes.filter(function (n) {
                return p.nodeSel.ev(n.labels);
            });
        });

        model.reservations = [];
        raw.reservations.items.forEach(function (r) {
            (dig(r, 'spec.reservedCIDRs') || []).forEach(function (text) {
                var net = parseCIDR(text.indexOf('/') < 0 ? text + (text.indexOf(':') >= 0 ? '/128' : '/32') : text);
                if (net) model.reservations.push({ name: r.metadata.name, obj: r, text: text, net: net });
            });
        });
        model.reservationsServed = raw.reservations.ok;
        model.pools.forEach(function (p) {
            p.reserved = model.reservations.filter(function (r) {
                return p.net && r.net.v === p.net.v && r.net.base < p.net.base + p.net.size && r.net.base + r.net.size > p.net.base;
            });
        });

        model.allocations = new Map();
        model.blocks = raw.blocks.items
            .filter(function (obj) {
                return !(obj.spec && obj.spec.deleted);
            })
            .map(function (obj) {
                return buildBlock(model, obj);
            })
            .filter(Boolean)
            .sort(function (a, b) {
                return a.net.v - b.net.v || (a.net.base < b.net.base ? -1 : a.net.base > b.net.base ? 1 : 0);
            });
        model.blockByName = {};
        model.blocks.forEach(function (b) {
            model.blockByName[b.name] = b;
            if (b.pool) {
                b.pool.blocks.push(b);
                b.pool.used += b.used;
                b.pool.borrowed += b.borrowed;
                b.pool.tunnels += b.tunnels;
            }
            var n = model.nodeByName[b.node];
            if (n) {
                n.blocks.push(b);
                n.used += b.used;
                n.capacity += b.size;
            }
        });
        model.allocations.forEach(function (at) {
            if (at.borrowed) {
                var host = model.nodeByName[at.node];
                if (host) host.borrowed++;
            }
        });
        model.orphanBlocks = model.blocks.filter(function (b) {
            return !b.pool;
        });

        // Affinities without a block, and the other way round, say something
        // is out of step.
        model.affinities = raw.affinities.items.map(function (a) {
            var spec = a.spec || {};
            return { name: a.metadata.name, obj: a, cidr: spec.cidr || '', node: spec.node || '', state: spec.state || '', type: spec.type || 'host', deleted: String(spec.deleted) === 'true' };
        });
        var blockCidrs = {};
        model.blocks.forEach(function (b) {
            blockCidrs[b.net.text] = b;
        });
        model.affinities.forEach(function (a) {
            var net = parseCIDR(a.cidr);
            a.block = net ? blockCidrs[net.text] || null : null;
        });
        model.pendingAffinities = model.affinities.filter(function (a) {
            return a.state && a.state !== 'confirmed';
        });
    }

    function buildBlock(model, obj) {
        var spec = obj.spec || {};
        var net = parseCIDR(spec.cidr);
        if (!net) return null;
        var aff = spec.affinity || '';
        var cut = aff.indexOf(':');
        var affType = cut > 0 ? aff.slice(0, cut) : '';
        var host = cut > 0 ? aff.slice(cut + 1) : '';
        var pool = null;
        for (var i = 0; i < model.pools.length; i++) {
            if (cidrInside(net, model.pools[i].net)) {
                pool = model.pools[i];
                break;
            }
        }
        var size = Number(net.size);
        var block = {
            name: obj.metadata.name,
            obj: obj,
            net: net,
            cidr: net.text,
            size: size,
            pool: pool,
            affinity: aff,
            affinityType: affType || (aff ? 'host' : ''),
            node: affType === 'host' ? host : '',
            virtual: affType === 'virtual' ? host : '',
            allocs: [],
            used: 0,
            borrowed: 0,
            tunnels: 0,
            releasing: 0,
            reserved: 0,
        };
        var attrs = spec.attributes || [];
        var list = spec.allocations || [];
        for (var ord = 0; ord < list.length && ord < size; ord++) {
            var idx = list[ord];
            if (idx === null || idx === undefined) continue;
            var attr = attrs[idx] || {};
            var sec = attr.secondary || {};
            var ip = { v: net.v, n: net.base + BigInt(ord) };
            var at = {
                key: ipKey(ip),
                ip: ip,
                text: formatIP(ip),
                ordinal: ord,
                block: block,
                handle: attr.handle_id || '',
                pod: sec.pod || '',
                namespace: sec.namespace || '',
                node: sec.node || '',
                type: sec.type || '',
                tunnel: TUNNEL_TYPES[sec.type] || '',
                released: !!attr.releasedAt,
                vmi: sec['vmi-name'] || '',
                borrowed: false,
            };
            // Borrowed: in use on a node other than the one the block is
            // affine to (libcalico-go AllocationBlock.NonAffineAllocations).
            at.borrowed = !!block.node && !!at.node && at.node !== block.node;
            if (at.pod && at.namespace) {
                var owner = model.podByKey[at.namespace + '/' + at.pod];
                at.podRef = owner || null;
                if (owner) owner.allocations.push(at);
            }
            block.allocs.push(at);
            block.used++;
            if (at.borrowed) block.borrowed++;
            if (at.tunnel) block.tunnels++;
            if (at.released) block.releasing++;
            model.allocations.set(at.key, at);
        }
        block.fraction = size ? block.used / size : 0;
        return block;
    }

    function blockOfIP(model, ip) {
        for (var i = 0; i < model.blocks.length; i++) {
            if (cidrHas(model.blocks[i].net, ip)) return model.blocks[i];
        }
        return null;
    }

    function poolOfIP(model, ip) {
        for (var i = 0; i < model.pools.length; i++) {
            if (cidrHas(model.pools[i].net, ip)) return model.pools[i];
        }
        return null;
    }

    function reservedAt(model, ip) {
        for (var i = 0; i < model.reservations.length; i++) {
            if (cidrHas(model.reservations[i].net, ip)) return model.reservations[i];
        }
        return null;
    }

    // ----- BGP -------------------------------------------------------------------

    function buildBGP(model, raw) {
        var conf = raw.bgpConfig.items.filter(function (c) {
            return c.metadata.name === 'default';
        })[0] || null;
        var spec = (conf && conf.spec) || {};
        var cidrs = function (list) {
            return (list || []).map(function (x) {
                return x.cidr;
            });
        };
        model.bgp = {
            served: raw.bgpConfig.ok,
            config: conf,
            configs: raw.bgpConfig.items,
            enabled: model.bgpEnabled,
            mesh: spec.nodeToNodeMeshEnabled !== false,
            asn: spec.asNumber || 64512,
            asnSet: spec.asNumber !== undefined,
            listenPort: spec.listenPort || 179,
            clusterIPs: cidrs(spec.serviceClusterIPs),
            externalIPs: cidrs(spec.serviceExternalIPs),
            lbIPs: cidrs(spec.serviceLoadBalancerIPs),
            communities: spec.communities || [],
            prefixAdvertisements: spec.prefixAdvertisements || [],
            bindMode: spec.bindMode || '',
            logSeverity: spec.logSeverityScreen || '',
            filters: raw.bgpFilters.items.map(function (f) {
                var fs = f.spec || {};
                return {
                    name: f.metadata.name,
                    obj: f,
                    counts: {
                        importV4: (fs.importV4 || []).length,
                        exportV4: (fs.exportV4 || []).length,
                        importV6: (fs.importV6 || []).length,
                        exportV6: (fs.exportV6 || []).length,
                    },
                };
            }),
            filtersServed: raw.bgpFilters.ok,
            peersServed: raw.bgpPeers.ok,
        };
        model.routeReflectors = model.nodes.filter(function (n) {
            return !!n.rr;
        });

        model.peers = raw.bgpPeers.items
            .map(function (p) {
                var ps = p.spec || {};
                var nodeSel = ps.nodeSelector ? S.parse(ps.nodeSelector) : null;
                var peerSel = ps.peerSelector ? S.parse(ps.peerSelector) : null;
                var scope = ps.node ? 'node' : ps.nodeSelector ? 'selector' : 'global';
                var from = model.nodes.filter(function (n) {
                    if (ps.node) return n.name === ps.node;
                    if (nodeSel) return nodeSel.ev(n.labels);
                    return true;
                });
                var peer = {
                    name: p.metadata.name,
                    obj: p,
                    scope: scope,
                    node: ps.node || '',
                    nodeSelector: ps.nodeSelector || '',
                    nodeSel: nodeSel,
                    peerSelector: ps.peerSelector || '',
                    peerSel: peerSel,
                    peerIP: ps.peerIP || '',
                    ip: stripPort(ps.peerIP || ''),
                    asn: ps.asNumber || '',
                    filters: ps.filters || [],
                    keepNextHop: ps.keepOriginalNextHop === true,
                    password: !!ps.password,
                    reachableBy: ps.reachableBy || '',
                    localWorkloadSelector: ps.localWorkloadSelector || '',
                    from: from,
                    to: [],
                    sessions: [],
                };
                // A peer by selector peers with other Calico nodes -- how
                // route reflectors are wired.
                if (peerSel) {
                    peer.to = model.nodes.filter(function (n) {
                        return peerSel.ev(n.labels);
                    });
                }
                return peer;
            })
            .sort(byName);

        // What calico-node says about each session, where a CalicoNodeStatus
        // asks it to.
        model.sessionsKnown = model.nodes.some(function (n) {
            return n.peers !== null;
        });
        model.sessions = [];
        model.nodes.forEach(function (n) {
            if (!n.peers) return;
            n.peers.forEach(function (s) {
                var ip = parseIP(stripMask(s.peerIP));
                var other = ip ? model.nodeByIP[ipKey(ip)] || null : null;
                var session = { node: n, ip: stripMask(s.peerIP), peerNode: other, type: s.type || '', state: s.state || '', since: s.since || '', up: s.state === 'Established' };
                model.sessions.push(session);
                model.peers.forEach(function (p) {
                    if (p.ip && p.ip === session.ip) {
                        session.peer = p;
                        p.sessions.push(session);
                    }
                });
            });
        });
    }

    function stripPort(text) {
        var m = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
        if (m) return m[1];
        if (/^[\d.]+:\d+$/.test(text)) return text.split(':')[0];
        return text;
    }

    function sessionBetween(model, a, bIP) {
        for (var i = 0; i < model.sessions.length; i++) {
            var s = model.sessions[i];
            if (s.node === a && s.ip === bIP) return s;
        }
        return null;
    }

    // ----- policy --------------------------------------------------------------------

    var ACTIONS = ['Allow', 'Deny', 'Pass', 'Log'];

    function defaultTypes(spec) {
        var hasIn = (spec.ingress || []).length > 0;
        var hasOut = (spec.egress || []).length > 0;
        if (hasOut && !hasIn) return ['Egress'];
        if (hasOut && hasIn) return ['Ingress', 'Egress'];
        return ['Ingress'];
    }

    function displayName(obj, tier) {
        var meta = calicoMeta(obj);
        var name = (meta && meta.name) || obj.metadata.name;
        var prefix = tier + '.';
        if (name.indexOf(prefix) === 0 && name.length > prefix.length) return name.slice(prefix.length);
        return name;
    }

    function portsText(ports) {
        return (ports || [])
            .map(function (p) {
                return String(p);
            })
            .join(', ');
    }

    function protoText(p) {
        if (p === undefined || p === null || p === '') return '';
        return String(p);
    }

    // One side of a Calico rule, as parts the pages draw.
    function entity(model, ent, ns, global) {
        ent = ent || {};
        var parts = [];
        var nsSel = ent.namespaceSelector ? S.parse(ent.namespaceSelector) : null;
        var sel = ent.selector ? S.parse(ent.selector) : null;
        var notSel = ent.notSelector ? S.parse(ent.notSelector) : null;
        var saNames = (ent.serviceAccounts && ent.serviceAccounts.names) || [];
        var saSel = ent.serviceAccounts && ent.serviceAccounts.selector ? S.parse(ent.serviceAccounts.selector) : null;
        var svc = ent.services || null;
        var errors = [];
        [nsSel, sel, notSel, saSel].forEach(function (x) {
            if (x && !x.ok) errors.push(x.error);
        });

        if (svc && svc.name) parts.push({ kind: 'svc', text: (svc.namespace || ns || '') + (svc.namespace || ns ? '/' : '') + svc.name, label: 'service' });
        if (nsSel) {
            if (nsSel.global) parts.push({ kind: 'global', text: 'global()', label: 'non-namespaced endpoints' });
            else if (nsSel.all) parts.push({ kind: 'ns', text: 'all()', label: 'every namespace' });
            else parts.push({ kind: 'ns', text: ent.namespaceSelector, label: 'namespaces', error: nsSel.ok ? '' : nsSel.error });
        }
        if (sel) parts.push({ kind: 'sel', text: ent.selector, label: 'pods', error: sel.ok ? '' : sel.error });
        if (notSel) parts.push({ kind: 'notsel', text: ent.notSelector, label: 'not', error: notSel.ok ? '' : notSel.error });
        if (saNames.length) parts.push({ kind: 'sa', text: saNames.join(', '), label: 'service accounts' });
        if (saSel) parts.push({ kind: 'sa', text: ent.serviceAccounts.selector, label: 'service accounts' });
        (ent.nets || []).forEach(function (n) {
            parts.push({ kind: 'net', text: n, label: 'net' });
        });
        (ent.notNets || []).forEach(function (n) {
            parts.push({ kind: 'notnet', text: n, label: 'not net' });
        });
        var ports = portsText(ent.ports);
        var notPorts = portsText(ent.notPorts);

        // Which pods this side can mean (libcalico-go rules.go
        // getEndpointSelector): a namespaced policy's selectors stay in its
        // own namespace unless a namespaceSelector says otherwise.
        var scoped = !!(sel || notSel || saSel || saNames.length || nsSel);
        var pods = null;
        // Rules repeat the same selectors; each combination is counted once.
        var memoKey = [global || nsSel ? '' : ns, ent.selector || '', ent.notSelector || '', ent.namespaceSelector || '', saNames.join(','), (ent.serviceAccounts && ent.serviceAccounts.selector) || ''].join('\u0001');
        var memo = model.entityCounts || (model.entityCounts = {});
        if (scoped && !svc && !(nsSel && nsSel.global) && model.podsKnown && memo[memoKey] !== undefined) {
            pods = memo[memoKey];
        } else if (scoped && !svc && !(nsSel && nsSel.global) && model.podsKnown) {
            pods = 0;
            var pool = !nsSel && !global ? (model.namespaceByName[ns] || { pods: [] }).pods : model.weps;
            for (var i = 0; i < pool.length; i++) {
                var p = pool[i];
                if (nsSel) {
                    var nsEntry = model.namespaceByName[p.namespace];
                    if (!nsSel.ev(nsEntry ? nsEntry.selectorLabels : {})) continue;
                } else if (!global && p.namespace !== ns) continue;
                if (sel && !sel.ev(p.selectorLabels)) continue;
                if (notSel && notSel.ev(p.selectorLabels)) continue;
                if (saNames.length && saNames.indexOf(p.serviceAccount) < 0) continue;
                if (saSel && !saSel.ev(p.saLabels)) continue;
                pods++;
            }
            memo[memoKey] = pods;
        }
        return {
            parts: parts,
            ports: ports,
            notPorts: notPorts,
            empty: !parts.length && !ports && !notPorts,
            pods: pods,
            sameNamespace: !global && !nsSel && scoped,
            errors: errors,
        };
    }

    function calicoRule(model, r, dir, ns, global) {
        var src = entity(model, r.source, ns, global);
        var dst = entity(model, r.destination, ns, global);
        var proto = protoText(r.protocol);
        var notProto = protoText(r.notProtocol);
        var extras = [];
        if (r.icmp) extras.push('ICMP type ' + (r.icmp.type !== undefined ? r.icmp.type : 'any') + (r.icmp.code !== undefined ? ' code ' + r.icmp.code : ''));
        if (r.notICMP) extras.push('not ICMP type ' + r.notICMP.type);
        if (r.http) {
            if (r.http.methods && r.http.methods.length) extras.push('HTTP ' + r.http.methods.join('/'));
            if (r.http.paths && r.http.paths.length) {
                extras.push(
                    'paths ' +
                        r.http.paths
                            .map(function (p) {
                                return p.exact || p.prefix + '*';
                            })
                            .join(', '),
                );
            }
        }
        if (r.ipVersion) extras.push('IPv' + r.ipVersion);
        var rule = {
            dir: dir,
            action: ACTIONS.indexOf(r.action) >= 0 ? r.action : r.action || 'Allow',
            proto: proto,
            notProto: notProto,
            extras: extras,
            src: src,
            dst: dst,
            k8s: false,
            errors: src.errors.concat(dst.errors),
        };
        rule.catchAll = !proto && !notProto && !extras.length && src.empty && dst.empty;
        rule.sentence = sentence(rule);
        return rule;
    }

    // The same thing for a networking.k8s.io rule: allow, from (or to) any of
    // the peers, on any of the ports.
    function k8sRule(model, r, dir, ns) {
        var peers = dir === 'in' ? r.from || [] : r.to || [];
        var parts = [];
        var pods = 0;
        var anyPods = false;
        peers.forEach(function (peer) {
            if (peer.ipBlock) {
                parts.push({ kind: 'net', text: peer.ipBlock.cidr, label: 'net' });
                (peer.ipBlock.except || []).forEach(function (e) {
                    parts.push({ kind: 'notnet', text: e, label: 'except' });
                });
                return;
            }
            anyPods = true;
            if (peer.namespaceSelector) {
                var t = S.k8sText(peer.namespaceSelector);
                parts.push({ kind: 'ns', text: t || 'every namespace', label: t ? 'namespaces' : 'in', any: !t });
            }
            if (peer.podSelector) {
                var pt = S.k8sText(peer.podSelector);
                parts.push({ kind: 'sel', text: pt || 'every pod', label: 'pods', any: !pt });
            }
            var scope = peer.namespaceSelector ? model.weps : (model.namespaceByName[ns] || { pods: [] }).pods;
            scope.forEach(function (p) {
                if (peer.namespaceSelector) {
                    var nsEntry = model.namespaceByName[p.namespace];
                    if (!S.k8s(peer.namespaceSelector, nsEntry ? nsEntry.labels : {})) return;
                } else if (p.namespace !== ns) return;
                if (peer.podSelector && !S.k8s(peer.podSelector, p.labels)) return;
                p.__hit = true;
            });
        });
        if (anyPods) {
            model.weps.forEach(function (p) {
                if (p.__hit) pods++;
                delete p.__hit;
            });
        }
        var ports = (r.ports || []).map(function (p) {
            return (p.protocol || 'TCP') + (p.port !== undefined ? ' ' + p.port + (p.endPort ? '-' + p.endPort : '') : '');
        });
        var protos = {};
        (r.ports || []).forEach(function (p) {
            protos[p.protocol || 'TCP'] = true;
        });
        var local = peers.some(function (peer) {
            return !peer.ipBlock && !peer.namespaceSelector;
        });
        // Ports are always the destination's: the selected pods' own on
        // ingress, the peer's on egress.
        var portText = ports.join(', ');
        var inbound = dir === 'in';
        var peerSide = { parts: parts, ports: inbound ? '' : portText, notPorts: '', empty: !parts.length && (inbound || !ports.length), pods: anyPods ? pods : null, sameNamespace: local, errors: [], portsHaveProto: true };
        var selfSide = { parts: [], ports: inbound ? portText : '', notPorts: '', empty: !inbound || !ports.length, pods: null, sameNamespace: false, errors: [], portsHaveProto: true };
        var rule = {
            dir: dir,
            action: 'Allow',
            proto: '',
            notProto: '',
            extras: [],
            src: dir === 'in' ? peerSide : selfSide,
            dst: dir === 'in' ? selfSide : peerSide,
            k8s: true,
            errors: [],
        };
        rule.catchAll = !parts.length && !ports.length;
        rule.sentence = sentence(rule);
        return rule;
    }

    // One side of a rule in words: "pods matching app == 'web' in namespaces
    // matching team == 'shop'", "10.0.0.0/8 except 10.0.5.0/24".
    function sideWords(side) {
        var byKind = {};
        side.parts.forEach(function (p) {
            (byKind[p.kind] = byKind[p.kind] || []).push(p.any ? '' : p.text);
        });
        var phrases = [];
        var who = '';
        if (byKind.sel) who = byKind.sel[0] === '' ? 'any pod' : 'pods matching ' + byKind.sel.join(' and ');
        else if (byKind.notsel) who = 'anything not matching ' + byKind.notsel.join(' or ');
        else if (byKind.ns || byKind.sa) who = 'any pod';
        if (byKind.sel && byKind.notsel) who += ' but not ' + byKind.notsel.join(' or ');
        if (byKind.ns) {
            var ns = byKind.ns[0];
            who += ns === 'all()' || ns === '' ? ' in any namespace' : ' in namespaces matching ' + ns;
        } else if (who && side.sameNamespace) {
            who += ' in this namespace';
        }
        if (byKind.sa) who += ' running as ' + byKind.sa.join(', ');
        if (who) phrases.push(who);
        if (byKind.global) phrases.push('global network sets and host endpoints');
        if (byKind.svc) phrases.push('service ' + byKind.svc.join(', '));
        if (byKind.net) phrases.push(byKind.net.join(', '));
        var text = phrases.join(', ');
        if (byKind.notnet) text += (text ? ' except ' : 'anything except ') + byKind.notnet.join(' and ');
        return text;
    }

    function portWords(ports, withProto) {
        if (!ports) return '';
        return withProto ? ports : 'port' + (/[,:-]/.test(ports) ? 's ' : ' ') + ports;
    }

    function sentence(rule) {
        var inbound = rule.dir === 'in';
        if (rule.catchAll) {
            if (rule.action === 'Pass') return 'Pass all ' + (inbound ? 'inbound' : 'outbound') + ' traffic on to the next tier.';
            if (rule.action === 'Log') return 'Log every packet, then carry on with the next rule.';
            return rule.action + ' all ' + (inbound ? 'inbound' : 'outbound') + ' traffic.';
        }
        var peer = inbound ? rule.src : rule.dst;
        var self = inbound ? rule.dst : rule.src;
        var what = rule.proto ? rule.proto + ' ' : rule.notProto ? 'non-' + rule.notProto + ' ' : '';
        var out = rule.action + ' ' + what + (rule.action === 'Log' ? 'packets' : 'traffic');
        var peerText = sideWords(peer);
        out += inbound ? ' from ' + (peerText || 'anywhere') : ' to ' + (peerText || 'anywhere');
        var ports = portWords(peer.ports || self.ports, (peer.ports ? peer : self).portsHaveProto);
        if (ports) out += ' on ' + ports;
        var notPorts = peer.notPorts || self.notPorts;
        if (notPorts) out += ' except ' + portWords(notPorts);
        var selfText = sideWords(self);
        if (selfText) out += inbound ? ', when it is for ' + selfText : ', when it comes from ' + selfText;
        if (rule.extras.length) out += ' (' + rule.extras.join(', ') + ')';
        if (rule.action === 'Pass') out += ', on to the next tier';
        if (rule.action === 'Log') out += ', then carry on';
        return out + '.';
    }

    function buildPolicies(model, raw) {
        model.policiesKnown = raw.nps.ok || raw.gnps.ok;
        model.stagedServed = raw.snps.ok || raw.sgnps.ok || raw.sknps.ok;
        model.policies = [];
        var add = function (obj, kind) {
            var p = kind === 'knp' || kind === 'sknp' ? k8sPolicy(model, obj, kind) : calicoPolicy(model, obj, kind);
            model.policies.push(p);
        };
        raw.nps.items.forEach(function (o) {
            add(o, 'np');
        });
        raw.gnps.items.forEach(function (o) {
            add(o, 'gnp');
        });
        raw.knps.items.forEach(function (o) {
            add(o, 'knp');
        });
        raw.snps.items.forEach(function (o) {
            add(o, 'snp');
        });
        raw.sgnps.items.forEach(function (o) {
            add(o, 'sgnp');
        });
        raw.sknps.items.forEach(function (o) {
            add(o, 'sknp');
        });

        // The tiers, in the order Calico evaluates them.
        var tiers = {};
        raw.tiers.items.forEach(function (t) {
            var spec = t.spec || {};
            var builtin = BUILTIN_TIERS[t.metadata.name];
            tiers[t.metadata.name] = {
                name: t.metadata.name,
                obj: t,
                order: typeof spec.order === 'number' ? spec.order : builtin ? builtin.order : Infinity,
                defaultAction: spec.defaultAction || (builtin ? builtin.action : 'Deny'),
                builtin: !!builtin,
                exists: true,
                policies: [],
            };
        });
        model.tiersServed = raw.tiers.ok;
        if (!tiers[DEFAULT_TIER]) {
            tiers[DEFAULT_TIER] = { name: DEFAULT_TIER, obj: null, order: DEFAULT_TIER_ORDER, defaultAction: 'Deny', builtin: true, exists: !raw.tiers.ok, implied: true, policies: [] };
        }
        model.policies.forEach(function (p) {
            var t = tiers[p.tier];
            if (!t) {
                t = tiers[p.tier] = { name: p.tier, obj: null, order: Infinity, defaultAction: 'Deny', builtin: false, exists: false, policies: [] };
            }
            t.policies.push(p);
            p.tierRef = t;
        });
        model.tiers = Object.keys(tiers)
            .map(function (k) {
                return tiers[k];
            })
            .sort(compareOrdered);
        model.tierByName = tiers;
        model.tiers.forEach(function (t, i) {
            t.index = i;
            t.policies.sort(compareOrdered);
            t.policies.forEach(function (p, j) {
                p.position = j;
            });
        });
        model.evaluation = [];
        model.tiers.forEach(function (t) {
            t.policies.forEach(function (p) {
                model.evaluation.push(p);
            });
        });

        // Which workloads each policy selects, and the other way round.
        var byNamespace = {};
        model.weps.forEach(function (p) {
            (byNamespace[p.namespace] = byNamespace[p.namespace] || []).push(p);
        });
        model.evaluation.forEach(function (pol) {
            var candidates = pol.namespace ? byNamespace[pol.namespace] || [] : model.weps;
            var hits = [];
            if (pol.error) {
                pol.matches = hits;
                return;
            }
            for (var i = 0; i < candidates.length; i++) {
                if (pol.test(candidates[i])) hits.push(candidates[i]);
            }
            pol.matches = hits;
            hits.forEach(function (pod) {
                (pol.staged ? pod.staged : pod.policies).push(pol);
            });
            var touched = {};
            hits.forEach(function (pod) {
                touched[pod.namespace] = true;
            });
            pol.namespaces = Object.keys(touched).sort();
            pol.namespaces.forEach(function (ns) {
                var entry = model.namespaceByName[ns];
                if (entry) entry.policies.push(pol);
            });
        });

        // Coverage: workloads at least one enforced policy selects.
        var covered = 0;
        model.weps.forEach(function (p) {
            if (p.policies.length) covered++;
        });
        model.coverage = { covered: covered, total: model.weps.length, fraction: model.weps.length ? covered / model.weps.length : 0 };
        model.openNamespaces = model.namespaces
            .filter(function (ns) {
                return (
                    ns.pods.length > 0 &&
                    !ns.pods.some(function (p) {
                        return p.policies.length > 0;
                    })
                );
            })
            .sort(byName);
    }

    function compareOrdered(a, b) {
        var ao = a.order === Infinity ? Number.MAX_VALUE : a.order;
        var bo = b.order === Infinity ? Number.MAX_VALUE : b.order;
        if (ao !== bo) return ao - bo;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    }

    function calicoPolicy(model, obj, kind) {
        var spec = obj.spec || {};
        var info = POLICY_KINDS[kind];
        var tier = spec.tier || DEFAULT_TIER;
        var global = kind === 'gnp' || kind === 'sgnp';
        var ns = global ? '' : obj.metadata.namespace || '';
        var sel = S.parse(spec.selector || '');
        var nsSel = global && spec.namespaceSelector ? S.parse(spec.namespaceSelector) : null;
        var saSel = spec.serviceAccountSelector ? S.parse(spec.serviceAccountSelector) : null;
        var errs = [];
        if (!sel.ok) errs.push('selector: ' + sel.error);
        if (nsSel && !nsSel.ok) errs.push('namespaceSelector: ' + nsSel.error);
        if (saSel && !saSel.ok) errs.push('serviceAccountSelector: ' + saSel.error);
        var types = spec.types && spec.types.length ? spec.types : defaultTypes(spec);
        var pol = {
            key: kind + ':' + (ns ? ns + '/' : '') + obj.metadata.name,
            kind: kind,
            info: info,
            staged: info.staged,
            stagedAction: spec.stagedAction || (info.staged ? 'Set' : ''),
            obj: obj,
            rawName: obj.metadata.name,
            name: displayName(obj, tier),
            namespace: ns,
            global: global,
            tier: tier,
            order: typeof spec.order === 'number' ? spec.order : Infinity,
            selector: spec.selector || '',
            namespaceSelector: global ? spec.namespaceSelector || '' : '',
            serviceAccountSelector: spec.serviceAccountSelector || '',
            types: types,
            ingress: types.indexOf('Ingress') >= 0,
            egress: types.indexOf('Egress') >= 0,
            doNotTrack: spec.doNotTrack === true,
            preDNAT: spec.preDNAT === true,
            applyOnForward: spec.applyOnForward === true,
            error: errs.join('; '),
            ref: { kind: info.kind, namespace: ns, name: obj.metadata.name },
            matches: [],
            namespaces: [],
        };
        pol.test = function (pod) {
            if (!sel.ev(pod.selectorLabels)) return false;
            if (nsSel) {
                var entry = model.namespaceByName[pod.namespace];
                if (!nsSel.ev(entry ? entry.selectorLabels : {})) return false;
            }
            if (saSel && !saSel.ev(pod.saLabels)) return false;
            return true;
        };
        pol.rulesIn = (spec.ingress || []).map(function (r) {
            return calicoRule(model, r, 'in', ns, global);
        });
        pol.rulesOut = (spec.egress || []).map(function (r) {
            return calicoRule(model, r, 'out', ns, global);
        });
        pol.ruleErrors = pol.rulesIn.concat(pol.rulesOut).some(function (r) {
            return r.errors.length > 0;
        });
        pol.selectorText = selectorText(pol);
        return pol;
    }

    function k8sPolicy(model, obj, kind) {
        var spec = obj.spec || {};
        var info = POLICY_KINDS[kind];
        var ns = obj.metadata.namespace || '';
        var types = spec.policyTypes && spec.policyTypes.length ? spec.policyTypes : ['Ingress'];
        var podSel = spec.podSelector || {};
        var pol = {
            key: kind + ':' + ns + '/' + obj.metadata.name,
            kind: kind,
            info: info,
            staged: info.staged,
            stagedAction: spec.stagedAction || (info.staged ? 'Set' : ''),
            obj: obj,
            rawName: obj.metadata.name,
            name: obj.metadata.name,
            namespace: ns,
            global: false,
            tier: DEFAULT_TIER,
            order: K8S_POLICY_ORDER,
            selector: S.k8sText(podSel),
            k8sSelector: podSel,
            namespaceSelector: '',
            serviceAccountSelector: '',
            calicoSelector: S.k8sToCalico(podSel, true),
            types: types,
            ingress: types.indexOf('Ingress') >= 0,
            egress: types.indexOf('Egress') >= 0,
            error: '',
            ref: { kind: info.kind, namespace: ns, name: obj.metadata.name },
            matches: [],
            namespaces: [],
        };
        pol.test = function (pod) {
            return S.k8s(podSel, pod.labels);
        };
        pol.rulesIn = (spec.ingress || []).map(function (r) {
            return k8sRule(model, r, 'in', ns);
        });
        pol.rulesOut = (spec.egress || []).map(function (r) {
            return k8sRule(model, r, 'out', ns);
        });
        pol.ruleErrors = false;
        pol.selectorText = pol.selector ? pol.selector : 'every pod in ' + ns;
        return pol;
    }

    function selectorText(pol) {
        var parts = [];
        parts.push(pol.selector || 'all()');
        if (pol.namespaceSelector) parts.push('ns: ' + pol.namespaceSelector);
        if (pol.serviceAccountSelector) parts.push('sa: ' + pol.serviceAccountSelector);
        return parts.join('  ·  ');
    }

    function policyByKey(model, key) {
        for (var i = 0; i < model.policies.length; i++) if (model.policies[i].key === key) return model.policies[i];
        return null;
    }

    function policyForRef(model, kind, namespace, name) {
        for (var i = 0; i < model.policies.length; i++) {
            var p = model.policies[i];
            if (p.ref.kind === kind && p.rawName === name && (p.namespace || '') === (namespace || '')) return p;
        }
        return null;
    }

    // ----- tracing -----------------------------------------------------------------

    // What happens to traffic in one direction for one workload, tier by tier
    // (docs: tiered policy). A tier with no policy for the pod is skipped. In
    // one that has, the policies run in order: the first rule that matches
    // decides, Pass sends the traffic on to the next tier, and what nothing
    // matched meets the tier's default action. Past the last tier -- or with
    // no policy at all -- the namespace's profile allows it.
    //
    // Rules are only known to match everything when they have no criteria,
    // so a tier is "decided" by its first catch-all Allow, Deny or Pass, and
    // a Pass with criteria before that lets some traffic reach later tiers.
    function trace(model, pod, dir) {
        var want = dir === 'in' ? 'ingress' : 'egress';
        var steps = [];
        var reach = 'all';
        var main = null;
        var passedBy = null;
        var passedOutcome = null;
        var applied = 0;
        model.tiers.forEach(function (tier) {
            var mine = tier.policies.filter(function (p) {
                return p[want] && p.matches.indexOf(pod) >= 0;
            });
            var enforced = mine.filter(function (p) {
                return !p.staged;
            });
            if (reach === 'none') {
                if (enforced.length) steps.push({ tier: tier, policies: mine, reach: 'none' });
                return;
            }
            if (!enforced.length) {
                steps.push({ tier: tier, policies: mine, skipped: true, reach: reach });
                return;
            }
            applied++;
            var step = { tier: tier, policies: mine, reach: reach, outcome: null, partial: null };
            for (var i = 0; i < enforced.length && !step.outcome; i++) {
                var rules = dir === 'in' ? enforced[i].rulesIn : enforced[i].rulesOut;
                for (var j = 0; j < rules.length; j++) {
                    var r = rules[j];
                    if (r.action === 'Log') continue;
                    if (!r.catchAll) {
                        if (r.action === 'Pass' && !step.partial) step.partial = { policy: enforced[i], rule: j };
                        continue;
                    }
                    step.outcome = { action: r.action, policy: enforced[i], rule: j, tier: tier };
                    break;
                }
            }
            if (!step.outcome) step.outcome = { action: tier.defaultAction, tierDefault: true, tier: tier };
            steps.push(step);
            if (step.outcome.action !== 'Pass') {
                if (reach === 'all') {
                    // Decides all traffic, except what a narrower Pass sent on.
                    main = step.outcome;
                    if (step.partial) {
                        passedBy = step.partial;
                        reach = 'some';
                    } else {
                        reach = 'none';
                    }
                } else {
                    // Decides what an earlier tier passed on.
                    passedOutcome = step.outcome;
                    reach = 'none';
                }
            }
        });
        var result;
        if (!applied) {
            result = { action: 'Allow', profile: true, text: 'No policy selects this pod for ' + want + ', so its namespace profile allows all of it.' };
        } else if (!main) {
            result = { action: 'Allow', profile: true, text: 'Every tier passes what it does not decide, so the rest reaches the namespace profile and is allowed.' };
        } else if (main.tierDefault) {
            result = { action: main.action, text: 'Anything the rules above do not allow is ' + (main.action === 'Deny' ? 'denied' : 'passed') + ' at the end of the tier.' };
        } else {
            result = { action: main.action, text: 'Everything left is ' + (main.action === 'Allow' ? 'allowed' : 'denied') + ' by ' + main.policy.name + ', rule ' + (main.rule + 1) + '.' };
        }
        if (passedBy) {
            var then = passedOutcome || { action: 'Allow', profile: true };
            var lead = 'What ' + passedBy.policy.name + ' rule ' + (passedBy.rule + 1) + ' passes on ';
            var verdict = then.action === 'Allow' ? 'allowed' : then.action === 'Deny' ? 'denied' : 'passed';
            result.passed = {
                policy: passedBy.policy,
                rule: passedBy.rule,
                action: then.action,
                text: then.profile
                    ? lead + 'meets no further policy, and the namespace profile allows it.'
                    : lead + 'is decided in the ' + then.tier.name + ' tier: what its rules do not allow there is ' + verdict + (then.tierDefault ? ' by the tier default.' : ' by ' + then.policy.name + ', rule ' + (then.rule + 1) + '.'),
            };
        }
        return { dir: dir, steps: steps, result: result, applied: applied };
    }

    // ----- colours -------------------------------------------------------------------

    function buildColors(model) {
        model.colors = {};
        var perNamespace = {};
        model.allocations.forEach(function (at) {
            if (at.namespace) perNamespace[at.namespace] = (perNamespace[at.namespace] || 0) + 1;
        });
        model.namespaceRank = Object.keys(perNamespace).sort(function (a, b) {
            return perNamespace[b] - perNamespace[a] || (a < b ? -1 : 1);
        });
        model.namespaceRank.forEach(function (ns, i) {
            model.colors[ns] = i < PALETTE ? chartColor(i) : OTHER_COLOR;
        });
        model.namespaceCounts = perNamespace;
        model.nodeColors = {};
        var withBlocks = model.nodes.filter(function (n) {
            return n.blocks.length > 0;
        });
        withBlocks.forEach(function (n, i) {
            model.nodeColors[n.name] = i < PALETTE ? chartColor(i) : OTHER_COLOR;
        });
        model.poolColors = {};
        model.pools.forEach(function (p, i) {
            model.poolColors[p.name] = chartColor(i);
        });
    }

    function colorOfNode(model, name) {
        return model.nodeColors[name] || OTHER_COLOR;
    }

    // ----- what needs attention -----------------------------------------------------

    function findings(model) {
        var out = [];
        if (!model.installed) return out;
        var push = function (tone, text, extra) {
            out.push(Object.assign({ tone: tone, text: text }, extra || {}));
        };

        // calico-node and friends.
        if (model.componentsKnown) {
            var down = model.nodes.filter(function (n) {
                return n.calico && !n.calicoReady;
            });
            if (down.length) {
                push('error', 'calico-node is not ready on ' + names(down) + '. Pods there may get no network, and policy changes are not programmed.', {
                    ref: { kind: KINDS.pods, namespace: down[0].calico.metadata.namespace, name: down[0].calico.metadata.name },
                    group: 'components',
                });
            }
            var missing = model.nodes.filter(function (n) {
                return !n.calico;
            });
            if (missing.length && model.nodesKnown) {
                push('warn', names(missing) + (missing.length === 1 ? ' has' : ' have') + ' no calico-node pod. Pods scheduled there cannot be networked by Calico.', { ref: { kind: KINDS.nodes, namespace: '', name: missing[0].name }, group: 'components' });
            }
        }
        var kc = model.components.controllers;
        if (kc.pods.length && !kc.ready) push('error', 'calico-kube-controllers is not ready. Leaked IP addresses are not cleaned up and node deletions are not tidied.', { ref: podRef(kc.pods[0]), group: 'components' });
        var ty = model.components.typha;
        if (ty.pods.length && ty.ready < ty.pods.length) push(ty.ready ? 'warn' : 'error', ty.ready + ' of ' + plural(ty.pods.length, 'Typha pod') + ' ready. calico-node reads the datastore through Typha.', { ref: podRef(ty.pods[0]), group: 'components' });
        model.tigera.forEach(function (s) {
            if (s.tone === 'error') push('error', 'The operator reports ' + s.name + ' as degraded' + (s.message ? ': ' + s.message : '.'), { ref: { kind: KINDS.tigeraStatus, namespace: '', name: s.name }, group: 'components' });
            else if (s.tone === 'warn') push('warn', 'The operator reports ' + s.name + ' as not available' + (s.message ? ': ' + s.message : '.'), { ref: { kind: KINDS.tigeraStatus, namespace: '', name: s.name }, group: 'components' });
        });
        if (model.datastoreReady === false) push('error', 'ClusterInformation says the datastore is not ready, so Calico components are waiting.', { group: 'components' });

        // Address space.
        if (!model.pools.length) push('error', 'There is no IP pool, so Calico has no addresses to give pods.', { view: 'ipam', group: 'ipam' });
        model.pools.forEach(function (p) {
            var ref = { kind: KINDS.pools, namespace: '', name: p.name };
            if (!p.net) {
                push('error', 'IP pool ' + p.name + ' has "' + p.cidr + '", which is not a CIDR.', { ref: ref, group: 'ipam' });
                return;
            }
            var fraction = share(p.used, p.capacity);
            if (fraction >= 0.8) push(fraction >= 0.95 ? 'error' : 'warn', 'IP pool ' + p.name + ' is ' + percent(fraction) + ' full (' + p.used + ' of ' + count(p.capacity) + ').', { ref: ref, group: 'ipam' });
            var blockShare = p.possibleBlocks > 0n ? Number(BigInt(p.blocks.length) * 1000n / p.possibleBlocks) / 1000 : 0;
            if (blockShare >= 0.9 && fraction < 0.8) push('warn', 'IP pool ' + p.name + ' has handed out ' + p.blocks.length + ' of its ' + count(p.possibleBlocks) + ' blocks; new nodes will have to borrow addresses.', { ref: ref, group: 'ipam' });
            if (p.disabled) push(p.used ? 'warn' : 'info', 'IP pool ' + p.name + ' is disabled' + (p.used ? '; ' + plural(p.used, 'address is', 'addresses are') + ' still in use from it.' : ', so nothing new is assigned from it.'), { ref: ref, group: 'ipam' });
            if (p.encap.id !== 'none' && p.ipipMode !== 'Never' && p.vxlanMode !== 'Never') push('error', 'IP pool ' + p.name + ' has both IPIP and VXLAN turned on, which Calico does not allow.', { ref: ref, group: 'ipam' });
            if (!p.nodeSel.ok) push('error', 'IP pool ' + p.name + ' has a nodeSelector that does not parse: ' + p.nodeSel.error, { ref: ref, group: 'ipam' });
            else if (model.nodesKnown && model.nodes.length && !p.nodes.length && !p.disabled) push('warn', 'IP pool ' + p.name + ' selects no node, so no pod gets an address from it.', { ref: ref, group: 'ipam' });
        });
        var borrowed = 0;
        var borrowers = {};
        model.allocations.forEach(function (at) {
            if (at.borrowed) {
                borrowed++;
                borrowers[at.node] = true;
            }
        });
        if (borrowed) {
            push('warn', plural(borrowed, 'address is', 'addresses are') + ' borrowed from blocks affine to another node (on ' + names(Object.keys(borrowers)) + '). Routes to them are less efficient; the node usually ran out of blocks.', { view: 'ipam', group: 'ipam' });
        }
        if (model.podsKnown) {
            var leaked = [];
            model.allocations.forEach(function (at) {
                if (at.pod && at.namespace && !at.podRef) leaked.push(at);
            });
            if (leaked.length) {
                push('warn', plural(leaked.length, 'address is', 'addresses are') + ' still held for pods that no longer exist (' + names(unique(leaked.map(function (at) {
                    return at.namespace + '/' + at.pod;
                })), 2) + '). calico-kube-controllers releases leaked addresses; if the number keeps growing, check it is running.', { view: 'ipam', group: 'ipam' });
            }
        }
        if (model.orphanBlocks.length) {
            push('warn', plural(model.orphanBlocks.length, 'IPAM block is', 'IPAM blocks are') + ' in no IP pool — ' + names(model.orphanBlocks.map(function (b) {
                return b.cidr;
            })) + '. The pool was probably deleted while addresses were still in use.', { ref: { kind: KINDS.blocks, namespace: '', name: model.orphanBlocks[0].name }, group: 'ipam' });
        }
        var strayBlocks = model.blocks.filter(function (b) {
            return b.node && model.nodesKnown && !model.nodeByName[b.node];
        });
        if (strayBlocks.length) push('warn', plural(strayBlocks.length, 'block is', 'blocks are') + ' still affine to a node that no longer exists (' + names(unique(strayBlocks.map(function (b) {
            return b.node;
        }))) + '). kube-controllers releases them once their addresses are free.', { view: 'ipam', group: 'ipam' });

        // Policy.
        model.policies.forEach(function (p) {
            var ref = p.ref;
            if (p.error) push('error', p.info.label + ' ' + p.name + (p.namespace ? ' in ' + p.namespace : '') + ' does not parse (' + p.error + '), so Calico cannot program it.', { ref: ref, policy: p, group: 'policy' });
            else if (model.podsKnown && !p.matches.length && !p.staged) {
                push(p.global ? 'info' : 'warn', p.info.label + ' ' + p.name + (p.namespace ? ' in ' + p.namespace : '') + ' applies to nothing: its selector matches no pod' + (p.global ? ' (it may still select host endpoints).' : '.'), { ref: ref, policy: p, group: 'policy' });
            }
            if (p.ruleErrors) push('error', p.info.label + ' ' + p.name + ' has a rule with a selector that does not parse.', { ref: ref, policy: p, group: 'policy' });
            if (p.tierRef && !p.tierRef.exists) push('error', p.name + ' is in tier "' + p.tier + '", which does not exist.', { ref: ref, policy: p, group: 'policy' });
        });
        var open = model.openNamespaces.filter(function (ns) {
            return !ns.system;
        });
        if (open.length) {
            push('warn', plural(open.length, 'namespace has', 'namespaces have') + ' pods and no network policy: ' + names(open, 4) + '. Every pod there accepts traffic from anywhere.', { view: 'policies', namespaces: open, group: 'policy' });
        }
        var staged = model.policies.filter(function (p) {
            return p.staged;
        });
        if (staged.length) push('info', plural(staged.length, 'staged policy is', 'staged policies are') + ' waiting: they are previewed, not enforced.', { view: 'policies', group: 'policy' });

        // Routing.
        model.nodes.forEach(function (n) {
            if (n.bird && n.bird !== 'Ready') push('error', 'BIRD is not ready on ' + n.name + ', so that node exchanges no routes.', { ref: { kind: KINDS.nodeStatus, namespace: '', name: n.status.metadata.name }, group: 'routing' });
        });
        var downSessions = model.sessions.filter(function (s) {
            return !s.up;
        });
        if (downSessions.length) {
            var who = downSessions.map(function (s) {
                return s.node.name + ' → ' + (s.peer ? s.peer.name : s.peerNode ? s.peerNode.name : s.ip) + ' (' + s.state + ')';
            });
            push('error', plural(downSessions.length, 'BGP session is', 'BGP sessions are') + ' not established: ' + names(who, 3) + '.', { view: 'routing', group: 'routing' });
        }
        model.peers.forEach(function (p) {
            if (p.nodeSel && !p.nodeSel.ok) push('error', 'BGP peer ' + p.name + ' has a nodeSelector that does not parse: ' + p.nodeSel.error, { ref: { kind: KINDS.bgpPeers, namespace: '', name: p.name }, group: 'routing' });
            else if (model.nodesKnown && !p.from.length) push('warn', 'BGP peer ' + p.name + ' applies to no node.', { ref: { kind: KINDS.bgpPeers, namespace: '', name: p.name }, group: 'routing' });
        });
        if (model.bgp.enabled !== false && !model.bgp.mesh && !model.peers.length && model.nodes.length > 1) {
            push('error', 'The node-to-node mesh is off and there is no BGP peer, so nodes learn no routes to each other’s pods.', { view: 'routing', group: 'routing' });
        }

        var rank = { error: 0, warn: 1, info: 2 };
        return out.sort(function (a, b) {
            return rank[a.tone] - rank[b.tone];
        });
    }

    function podRef(pod) {
        return { kind: KINDS.pods, namespace: pod.metadata.namespace, name: pod.metadata.name };
    }

    function unique(list) {
        return list.filter(function (x, i) {
            return list.indexOf(x) === i;
        });
    }

    // ----- numbers ------------------------------------------------------------------

    // A BigInt count written for a person: exact while it is small enough to
    // read, a power of two once it is not.
    function count(big) {
        if (typeof big === 'number') big = BigInt(Math.round(big));
        if (big < 1000000n) return Number(big).toLocaleString('en-US');
        if (big < 1000000000n) return (Number(big) / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        var bits = big.toString(2).length - 1;
        return big === 1n << BigInt(bits) ? '2^' + bits : '≈ 2^' + bits;
    }

    function share(used, capacity) {
        if (typeof capacity === 'bigint') {
            if (capacity === 0n) return 0;
            if (capacity > 1000000000n) return used > 0 ? Math.max(0.0001, Number((BigInt(used) * 1000000n) / capacity) / 1000000) : 0;
            return Math.min(1, used / Number(capacity));
        }
        return capacity ? Math.min(1, used / capacity) : 0;
    }

    function percent(fraction) {
        if (fraction === 0) return '0%';
        if (fraction < 0.01) return '<1%';
        if (fraction > 0.99 && fraction < 1) return '99%';
        return Math.round(fraction * 100) + '%';
    }

    function shortVersion(v) {
        return String(v || '').replace(/^v/, '');
    }

    window.Calico = {
        KINDS: KINDS,
        POLICY_KINDS: POLICY_KINDS,
        COMPONENTS: COMPONENTS,
        NODE_ANN: NODE_ANN,
        DEFAULT_TIER: DEFAULT_TIER,
        load: load,
        build: build,
        parseIP: parseIP,
        formatIP: formatIP,
        parseCIDR: parseCIDR,
        cidrHas: cidrHas,
        ipKey: ipKey,
        keyToIP: keyToIP,
        stripMask: stripMask,
        blockOfIP: blockOfIP,
        poolOfIP: poolOfIP,
        reservedAt: reservedAt,
        policyByKey: policyByKey,
        policyForRef: policyForRef,
        sessionBetween: sessionBetween,
        trace: trace,
        colorOfNode: colorOfNode,
        count: count,
        share: share,
        percent: percent,
        plural: plural,
        names: names,
        dig: dig,
        podReady: podReady,
        condition: condition,
        shortVersion: shortVersion,
        isSystemNamespace: isSystemNamespace,
        podRef: podRef,
    };
})();
