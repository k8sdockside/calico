// The drawing kit the pages share: icons, gauges, chips, the policy badges
// and rule flows, the IPAM block tiles and seat maps, the tooltip, the grip
// that resizes an inspector, and the few calls that ask the app to change
// something.
//
// Everything that came from the cluster is written with textContent, never
// innerHTML: the frame is sandboxed, but a page that let a policy's name run
// as markup would be handing that name the bridge.
(function () {
    'use strict';

    var C = window.Calico;
    var SVG = 'http://www.w3.org/2000/svg';

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function add(parent) {
        for (var i = 1; i < arguments.length; i++) {
            var child = arguments[i];
            if (child === null || child === undefined || child === false) continue;
            if (Array.isArray(child)) {
                child.forEach(function (c) {
                    add(parent, c);
                });
                continue;
            }
            parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
        }
        return parent;
    }

    function svg(tag, attrs) {
        var node = document.createElementNS(SVG, tag);
        Object.keys(attrs || {}).forEach(function (k) {
            node.setAttribute(k, attrs[k]);
        });
        return node;
    }

    function dot(cx, cy, r) {
        return 'M' + (cx + r) + ' ' + cy + 'a' + r + ' ' + r + ' 0 1 1-' + 2 * r + ' 0 ' + r + ' ' + r + ' 0 0 1 ' + 2 * r + ' 0z';
    }

    // Single-stroke icons on a 24-unit grid. The logo is a mark of this
    // plugin's own: a hexagon holding three joined nodes.
    var CIRCLE = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z';
    var SHIELD = 'M12 3l7.5 3v5.2c0 4.6-3.1 8.3-7.5 9.8-4.4-1.5-7.5-5.2-7.5-9.8V6z';
    var ICONS = {
        logo: ['M12 2.6l8.2 4.7v9.4L12 21.4l-8.2-4.7V7.3z', 'M12 9.4v3.1', 'M12 12.5l-2.9 1.8', 'M12 12.5l2.9 1.8', dot(12, 8.1, 1.5), dot(7.9, 15.1, 1.5), dot(16.1, 15.1, 1.5)],
        pool: ['M4 6.5C4 5 7.6 4 12 4s8 1 8 2.5S16.4 9 12 9 4 8 4 6.5z', 'M4 6.5v5C4 13 7.6 14 12 14s8-1 8-2.5v-5', 'M4 11.5v5C4 18 7.6 19 12 19s8-1 8-2.5v-5'],
        grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
        node: ['M4 4h16v6H4z', 'M4 14h16v6H4z', 'M8 7h.01', 'M8 17h.01'],
        pod: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
        shield: [SHIELD],
        shieldCheck: [SHIELD, 'M8.8 12.2l2.2 2.2 4.2-4.4'],
        shieldOff: [SHIELD, 'M9.7 9.7l4.6 4.6', 'M14.3 9.7l-4.6 4.6'],
        shieldPlus: [SHIELD, 'M12 9v6', 'M9 12h6'],
        tier: ['M12 3.5l8.5 4.5-8.5 4.5L3.5 8z', 'M3.5 12.3l8.5 4.5 8.5-4.5', 'M3.5 16.3l8.5 4.5 8.5-4.5'],
        globe: [CIRCLE, 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
        route: [dot(6, 18, 2), dot(18, 6, 2), 'M8 18h6.5a3 3 0 0 0 0-6h-5a3 3 0 0 1 0-6H16'],
        mesh: [dot(12, 5, 2), dot(5, 18, 2), dot(19, 18, 2), 'M11 6.8l-5 9.4', 'M13 6.8l5 9.4', 'M7 18h10'],
        tunnel: ['M6 7h12', 'M6 17h12', 'M6 7a2.4 5 0 0 0 0 10', 'M6 7a2.4 5 0 0 1 0 10', 'M18 7a2.4 5 0 0 1 0 10'],
        lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3', 'M12 14.5v2'],
        nat: ['M14 4h5v16h-5', 'M3 12h11', 'M10 8l4 4-4 4'],
        dual: ['M4 4h11v11H4z', 'M9 9h11v11H9z'],
        fan: [dot(5, 12, 2), 'M7 12h3', 'M10 12l9-6', 'M10 12h9', 'M10 12l9 6'],
        api: ['M9 4H8a2 2 0 0 0-2 2v3.5A2.5 2.5 0 0 1 4 12a2.5 2.5 0 0 1 2 2.5V18a2 2 0 0 0 2 2h1', 'M15 4h1a2 2 0 0 1 2 2v3.5a2.5 2.5 0 0 0 2 2.5 2.5 2.5 0 0 0-2 2.5V18a2 2 0 0 1-2 2h-1'],
        flows: ['M3 9c3-3 6 3 9 0s6-3 9 0', 'M3 15c3-3 6 3 9 0s6-3 9 0'],
        tag: ['M3.5 12.5V4h8.5l9 9-8.5 8.5z', 'M8 8.5h.01'],
        ruler: ['M3 16.5L16.5 3 21 7.5 7.5 21z', 'M7.5 12l2 2', 'M10.5 9l2 2', 'M13.5 6l2 2'],
        chip: ['M7 7h10v10H7z', 'M10 3v4', 'M14 3v4', 'M10 17v4', 'M14 17v4', 'M3 10h4', 'M3 14h4', 'M17 10h4', 'M17 14h4'],
        bolt: ['M13 3L5 14h6l-1 7 8-11h-6z'],
        alert: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17.5h.01'],
        check: ['M4 12.5l5 5L20 6.5'],
        info: [CIRCLE, 'M12 11v6', 'M12 7.5h.01'],
        search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
        arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
        down: ['M12 5v14', 'M6 13l6 6 6-6'],
        back: ['M15 5l-7 7 7 7'],
        chevron: ['M9 6l6 6-6 6'],
        edit: ['M4 20h4L19 9l-4-4L4 16z', 'M14 6l4 4'],
        open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
        close: ['M6 6l12 12', 'M18 6L6 18'],
        clock: [CIRCLE, 'M12 7v5l3 2'],
        chart: ['M4 4v16h16', 'M8 15l3-4 3 2 5-6'],
        activity: ['M3 12h4l3-8 4 16 3-8h4'],
        pass: ['M4 6l7 6-7 6', 'M13 6l7 6-7 6'],
        allow: [CIRCLE, 'M8 12.5l3 3 5-6'],
        deny: [CIRCLE, 'M9 9l6 6', 'M15 9l-6 6'],
        log: ['M5 6h14', 'M5 12h14', 'M5 18h9'],
        trace: [dot(5, 19, 2), dot(19, 5, 2), 'M7 19c6 0 4-7 7.5-10.5S19 7 19 7'],
        lanes: ['M3 4h18v5H3z', 'M3 11h11v5H3z', 'M3 18h7'],
        star: ['M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z'],
        cloud: ['M7 18.5h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.1 11.8 3.4 3.4 0 0 0 7 18.5z'],
        copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
        eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', dot(12, 12, 3)],
        ns: ['M8 4H5a1 1 0 0 0-1 1v3', 'M16 4h3a1 1 0 0 1 1 1v3', 'M8 20H5a1 1 0 0 1-1-1v-3', 'M16 20h3a1 1 0 0 0 1-1v-3', 'M9 12h6'],
        user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
        share: [dot(5, 12, 2.5), dot(19, 6, 2.5), dot(19, 18, 2.5), 'M7.3 10.9l9.4-3.8', 'M7.3 13.1l9.4 3.8'],
        plus: ['M12 5v14', 'M5 12h14'],
        filter: ['M3 5h18l-7 8v6l-4 2v-8z'],
        home: ['M4 11l8-7 8 7', 'M6 9.5V20h12V9.5'],
        spark: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M6 6l2.5 2.5', 'M15.5 15.5L18 18', 'M6 18l2.5-2.5', 'M15.5 8.5L18 6'],
        ban: [CIRCLE, 'M5.6 5.6l12.8 12.8'],
        repeat: ['M4.5 11a7.5 7.5 0 0 1 13.4-4.2L20 9', 'M20 4v5h-5', 'M19.5 13a7.5 7.5 0 0 1-13.4 4.2L4 15', 'M4 20v-5h5'],
    };

    function icon(name, className) {
        var node = svg('svg', { viewBox: '0 0 24 24', class: 'ico' + (className ? ' ' + className : ''), 'aria-hidden': 'true' });
        (ICONS[name] || ICONS.info).forEach(function (d) {
            node.appendChild(svg('path', { d: d }));
        });
        return node;
    }

    function logo(className) {
        var node = el('span', 'logo' + (className ? ' ' + className : ''));
        node.appendChild(icon('logo'));
        return node;
    }

    function chip(text, tone, iconName, title) {
        var node = el('span', 'chip' + (tone ? ' ' + tone : ''));
        if (iconName) node.appendChild(icon(iconName));
        node.appendChild(el('span', '', text));
        if (title) node.title = title;
        return node;
    }

    function sdot(tone, title) {
        var node = el('i', 'sdot ' + (tone || 'muted'));
        if (title) node.title = title;
        return node;
    }

    function button(text, className, iconName, onClick) {
        var node = el('button', className || '');
        node.type = 'button';
        if (iconName) node.appendChild(icon(iconName));
        if (text) node.appendChild(el('span', '', text));
        if (onClick) node.addEventListener('click', onClick);
        return node;
    }

    function iconButton(iconName, label, onClick) {
        var node = button('', 'icon-button', iconName, onClick);
        node.title = label;
        node.setAttribute('aria-label', label);
        return node;
    }

    function link(text, onClick, title) {
        var node = el('button', 'link', text);
        node.type = 'button';
        if (title) node.title = title;
        node.addEventListener('click', function (event) {
            event.stopPropagation();
            onClick(event);
        });
        return node;
    }

    // What the plugin is about, from its manifest's links.
    function about(sdk, plugin, onError) {
        if (!plugin || !plugin.links || !plugin.links.length) return null;
        var row = el('div', 'about');
        row.appendChild(el('span', 'about-label', plugin.version ? 'Plugin ' + plugin.version + ' ·' : 'About'));
        plugin.links.forEach(function (l) {
            row.appendChild(
                link(
                    l.label,
                    function () {
                        sdk.openUrl(l.url).catch(onError || function () {});
                    },
                    l.url,
                ),
            );
        });
        return row;
    }

    function plural(n, one, many) {
        return C.plural(n, one, many);
    }

    // ----- gauges --------------------------------------------------------------

    function ring(fraction, size, tone, label) {
        var r = size / 2 - 5;
        var c = 2 * Math.PI * r;
        var node = svg('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'ring ' + (tone || ''), width: size, height: size, role: 'img' });
        node.setAttribute('aria-label', label || Math.round(fraction * 100) + '%');
        node.appendChild(svg('circle', { cx: size / 2, cy: size / 2, r: r, class: 'track' }));
        if (fraction <= 0) return node;
        node.appendChild(
            svg('circle', {
                cx: size / 2,
                cy: size / 2,
                r: r,
                class: 'arc',
                'stroke-dasharray': Math.max(2, fraction * c) + ' ' + c,
                transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
            }),
        );
        return node;
    }

    function meter(fraction, tone, title) {
        var node = el('div', 'meter ' + (tone || ''));
        var fill = el('i');
        fill.style.width = fraction > 0 ? Math.max(1.5, fraction * 100) + '%' : '0';
        node.appendChild(fill);
        if (title) node.title = title;
        return node;
    }

    function fillTone(fraction) {
        if (fraction >= 0.95) return 'error';
        if (fraction >= 0.8) return 'warn';
        return 'ok';
    }

    // A labelled meter: "Addresses  12 / 1,024  1%".
    function usage(label, used, total, fraction, tone) {
        var box = el('div', 'usage');
        var head = el('div', 'usage-head');
        add(head, el('span', 'usage-label', label), el('span', 'usage-nums', used + ' / ' + total), el('span', 'pct ' + (tone || fillTone(fraction)), C.percent(fraction)));
        add(box, head, meter(fraction, tone || fillTone(fraction)));
        return box;
    }

    // ----- time --------------------------------------------------------------------

    function age(timestamp) {
        if (!timestamp) return '';
        var seconds = Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 1000);
        if (seconds < 90) return Math.round(seconds) + 's';
        if (seconds < 5400) return Math.round(seconds / 60) + 'm';
        if (seconds < 172800) return Math.round(seconds / 3600) + 'h';
        return Math.round(seconds / 86400) + 'd';
    }

    function ago(timestamp) {
        if (!timestamp) return '';
        if (Date.now() - new Date(timestamp).getTime() < 10000) return 'just now';
        return age(timestamp) + ' ago';
    }

    // ----- policies ------------------------------------------------------------------

    var ACTION_TONE = { Allow: 'allow', Deny: 'deny', Pass: 'pass', Log: 'log' };

    function kindBadge(pol, long) {
        var node = el('span', 'kbadge k-' + pol.kind.replace(/^s(?=np|gnp|knp)/, ''));
        node.textContent = pol.info.badge;
        node.title = pol.info.label;
        if (!long) return node;
        var wrap = el('span', 'kbadges');
        wrap.appendChild(node);
        if (pol.staged) wrap.appendChild(el('span', 'kbadge k-staged', 'staged'));
        return wrap;
    }

    function actionPill(action, small) {
        var node = el('span', 'apill ' + (ACTION_TONE[action] || 'log') + (small ? ' small' : ''));
        node.appendChild(icon({ Allow: 'allow', Deny: 'deny', Pass: 'pass', Log: 'log' }[action] || 'info'));
        node.appendChild(el('span', '', action));
        return node;
    }

    // A row of pips, one per rule, coloured by action.
    function pips(rules, max) {
        max = max || 12;
        var node = el('span', 'pips');
        if (!rules.length) {
            node.appendChild(el('span', 'pips-none', 'no rules'));
            return node;
        }
        rules.slice(0, max).forEach(function (r, i) {
            var pip = el('i', 'pip ' + (ACTION_TONE[r.action] || 'log') + (r.catchAll ? ' all' : ''));
            pip.title = 'Rule ' + (i + 1) + ': ' + r.sentence;
            node.appendChild(pip);
        });
        if (rules.length > max) node.appendChild(el('span', 'pips-more', '+' + (rules.length - max)));
        return node;
    }

    var PART_ICON = { sel: 'pod', notsel: 'ban', ns: 'ns', global: 'globe', net: 'globe', notnet: 'ban', sa: 'user', svc: 'share' };

    function part(p) {
        var node = el('span', 'part p-' + p.kind + (p.error ? ' bad' : ''));
        node.appendChild(icon(PART_ICON[p.kind] || 'info'));
        if (p.kind === 'ns' || p.kind === 'sa' || p.kind === 'notsel' || p.kind === 'notnet' || p.kind === 'svc') node.appendChild(el('span', 'part-label', p.label));
        node.appendChild(p.any ? el('span', 'part-any', p.text) : el('code', '', p.text));
        node.title = p.error ? 'Does not parse: ' + p.error : p.label + ': ' + p.text;
        return node;
    }

    // One side of a rule as a box: what it names, and how many pods that is.
    function side(s, fallback, selfSide) {
        var box = el('div', 'rside' + (selfSide ? ' self' : ''));
        if (!s.parts.length) {
            box.appendChild(el('span', 'rside-any', fallback));
        }
        s.parts.forEach(function (p) {
            box.appendChild(part(p));
        });
        if (s.ports) {
            var ports = el('span', 'part p-port');
            add(ports, el('span', 'part-label', s.portsHaveProto ? 'ports' : 'port'), el('code', '', s.ports));
            box.appendChild(ports);
        }
        if (s.notPorts) {
            var np = el('span', 'part p-port bad-soft');
            add(np, el('span', 'part-label', 'not port'), el('code', '', s.notPorts));
            box.appendChild(np);
        }
        if (s.pods !== null && s.pods !== undefined && s.parts.length) {
            box.appendChild(el('span', 'rside-count' + (s.pods === 0 ? ' zero' : ''), s.pods === 0 ? 'matches no pod' : plural(s.pods, 'pod')));
        }
        if (s.sameNamespace) box.appendChild(el('span', 'rside-note', 'this namespace'));
        return box;
    }

    // Every rule of one direction, rule by rule: the action, the protocol,
    // source -> destination, and what it means in a sentence.
    function ruleFlow(pol, dir, opts) {
        opts = opts || {};
        var rules = dir === 'in' ? pol.rulesIn : pol.rulesOut;
        var list = el('ol', 'rules' + (opts.compact ? ' compact' : ''));
        var applies = dir === 'in' ? pol.ingress : pol.egress;
        if (!rules.length) {
            var none = el('li', 'rule-none');
            none.textContent = applies
                ? 'No ' + (dir === 'in' ? 'ingress' : 'egress') + ' rules: every ' + (dir === 'in' ? 'inbound' : 'outbound') + ' connection of the selected pods meets the end of the ' + pol.tier + ' tier (' + (pol.tierRef ? pol.tierRef.defaultAction.toLowerCase() : 'deny') + ').'
                : 'This policy does not apply to ' + (dir === 'in' ? 'ingress' : 'egress') + '.';
            list.appendChild(none);
            return list;
        }
        rules.forEach(function (r, i) {
            var item = el('li', 'rule ' + (ACTION_TONE[r.action] || 'log'));
            var top = el('div', 'rule-top');
            add(top, el('span', 'rule-n', String(i + 1)), actionPill(r.action, opts.compact));
            var proto = r.proto ? r.proto : r.notProto ? 'not ' + r.notProto : r.k8s ? '' : 'any protocol';
            if (proto) top.appendChild(el('span', 'rule-proto', proto));
            r.extras.forEach(function (x) {
                top.appendChild(el('span', 'rule-proto', x));
            });
            item.appendChild(top);
            if (!opts.compact || !r.catchAll) {
                var flow = el('div', 'rule-flow');
                var src = side(r.src, dir === 'in' ? 'anywhere' : 'the selected pods', dir === 'out');
                var dst = side(r.dst, dir === 'in' ? 'the selected pods' : 'anywhere', dir === 'in');
                var arrow = el('span', 'rule-arrow');
                arrow.appendChild(icon('arrow'));
                add(flow, src, arrow, dst);
                item.appendChild(flow);
            }
            item.appendChild(el('p', 'rule-says', r.sentence));
            list.appendChild(item);
        });
        return list;
    }

    function selectorCode(text, error, placeholder) {
        var box = el('div', 'selcode' + (error ? ' bad' : ''));
        box.appendChild(el('code', '', text || placeholder || 'all()'));
        if (error) {
            var e = el('div', 'selcode-err');
            add(e, icon('alert'), el('span', '', error));
            box.appendChild(e);
        }
        return box;
    }

    // A policy as one line: badge, name, where, pips, count.
    function policyLine(pol, onClick, opts) {
        opts = opts || {};
        var row = button('', 'pline' + (pol.staged ? ' staged' : '') + (pol.error ? ' bad' : ''), null, onClick);
        add(row, kindBadge(pol));
        var who = el('span', 'pline-who');
        add(who, el('span', 'pline-name', pol.name), el('span', 'pline-sub', (pol.namespace || 'global') + (opts.tier ? ' · ' + pol.tier : '') + ' · order ' + orderText(pol.order)));
        row.appendChild(who);
        var dirs = el('span', 'pline-dirs');
        if (!opts.dir || opts.dir === 'in') {
            if (pol.ingress) add(dirs, add(el('span', 'pline-dir'), el('span', 'dir-tag', 'in'), pips(pol.rulesIn, 8)));
        }
        if (!opts.dir || opts.dir === 'out') {
            if (pol.egress) add(dirs, add(el('span', 'pline-dir'), el('span', 'dir-tag', 'out'), pips(pol.rulesOut, 8)));
        }
        row.appendChild(dirs);
        if (pol.staged) row.appendChild(el('span', 'kbadge k-staged', 'staged'));
        return row;
    }

    function orderText(order) {
        if (order === Infinity || order === undefined || order === null) return '∞';
        return Number.isInteger(order) ? String(order) : String(Math.round(order * 1000) / 1000);
    }

    // ----- IPAM ----------------------------------------------------------------------

    // A block written short, relative to its pool: 10.244.3.64/26 in
    // 10.244.0.0/16 reads "3.64".
    function shortCIDR(block) {
        var net = block.net;
        var pool = block.pool ? block.pool.net : null;
        if (net.v === 4) {
            var octets = C.formatIP({ v: 4, n: net.base }).split('.');
            var keep = pool ? Math.floor(pool.prefix / 8) : 2;
            keep = Math.max(0, Math.min(3, keep));
            return (keep ? '' : '') + octets.slice(keep).join('.');
        }
        var text = C.formatIP({ v: 6, n: net.base });
        if (/::$/.test(text)) return '…::0';
        var cut = text.lastIndexOf('::');
        if (cut >= 0 && cut + 2 < text.length) return '…' + text.slice(cut);
        var groups = text.split(':');
        return '…:' + groups.slice(-2).join(':');
    }

    function blockTile(block, model, opts) {
        opts = opts || {};
        var t = el('button', 'btile' + (block.borrowed ? ' borrowed' : '') + (!block.node ? ' loose' : '') + (opts.selected ? ' sel' : '') + (opts.faded ? ' faded' : '') + (opts.hit ? ' hit' : ''));
        t.type = 'button';
        t.dataset.block = block.name;
        var color = block.node ? C.colorOfNode(model, block.node) : 'var(--k-faint)';
        t.style.setProperty('--c', color);
        t.style.setProperty('--f', String(Math.max(block.used ? 0.06 : 0, block.fraction)));
        add(t, el('span', 'btile-fill'), el('span', 'btile-cidr', shortCIDR(block)), el('span', 'btile-n', block.used + '/' + block.size));
        if (block.borrowed) {
            var mark = el('span', 'btile-borrow');
            mark.title = block.borrowed + ' borrowed';
            t.appendChild(mark);
        }
        return t;
    }

    // Up to this many addresses in a block are drawn one square each; a
    // bigger block is drawn as 256 squares, each a slice of it.
    var ONE_EACH = 1024;
    var SLICES = 256;

    function seatMap(block, model, opts) {
        opts = opts || {};
        var cols = opts.cols || 16;
        var grid = el('div', 'seatgrid');
        grid.style.setProperty('--cols', String(cols));
        if (opts.cell) grid.style.setProperty('--cell', opts.cell + 'px');
        if (opts.hits) grid.classList.add('searching');
        var byOrdinal = {};
        block.allocs.forEach(function (a) {
            byOrdinal[a.ordinal] = a;
        });
        var rowText = function (ord) {
            var ip = { v: block.net.v, n: block.net.base + BigInt(ord) };
            var text = C.formatIP(ip);
            if (block.net.v === 4) return '.' + text.split('.').pop();
            return ':' + text.split(':').pop();
        };
        if (block.size <= ONE_EACH) {
            for (var ord = 0; ord < block.size; ord++) {
                if (ord % cols === 0) grid.appendChild(el('span', 'row-label', rowText(ord)));
                var at = byOrdinal[ord];
                var cell = el('i', 'seat');
                cell.dataset.block = block.name;
                cell.dataset.ord = String(ord);
                if (at) {
                    cell.classList.add('used');
                    if (at.tunnel) cell.classList.add('tunnel');
                    else cell.style.setProperty('--c', model.colors[at.namespace] || 'var(--k-faint)');
                    if (at.borrowed) cell.classList.add('borrowed');
                    if (at.released) cell.classList.add('released');
                    if (opts.hits && opts.hits.has(at.key)) cell.classList.add('hit');
                    if (opts.selected === at.key) cell.classList.add('sel');
                } else {
                    var ip = { v: block.net.v, n: block.net.base + BigInt(ord) };
                    if (model.reservations.length && C.reservedAt(model, ip)) cell.classList.add('reserved');
                }
                grid.appendChild(cell);
            }
        } else {
            var step = Math.ceil(block.size / SLICES);
            var usedIn = new Array(SLICES).fill(0);
            block.allocs.forEach(function (a) {
                usedIn[Math.floor(a.ordinal / step)]++;
            });
            for (var s = 0; s < SLICES; s++) {
                if (s % cols === 0) grid.appendChild(el('span', 'row-label', rowText(s * step)));
                var slice = el('i', 'seat slice');
                slice.dataset.block = block.name;
                slice.dataset.from = String(s * step);
                slice.dataset.size = String(step);
                slice.dataset.used = String(usedIn[s]);
                if (usedIn[s]) {
                    slice.classList.add('used');
                    slice.style.setProperty('--c', 'var(--k-accent)');
                    slice.style.setProperty('--a', String(Math.min(1, 0.35 + usedIn[s] / step)));
                }
                grid.appendChild(slice);
            }
        }
        return grid;
    }

    function describeSeat(model, seat, into) {
        var block = model.blockByName[seat.dataset.block];
        if (!block) return false;
        if (seat.classList.contains('slice')) {
            var from = Number(seat.dataset.from);
            var size = Number(seat.dataset.size);
            var a = C.formatIP({ v: block.net.v, n: block.net.base + BigInt(from) });
            var b = C.formatIP({ v: block.net.v, n: block.net.base + BigInt(Math.min(block.size, from + size) - 1) });
            add(into, el('code', 'tip-head', a + ' – ' + b), el('div', 'tip-line', seat.dataset.used + ' of ' + size + ' in use'));
            return true;
        }
        var ord = Number(seat.dataset.ord);
        var ip = { v: block.net.v, n: block.net.base + BigInt(ord) };
        var at = model.allocations.get(C.ipKey(ip));
        add(into, el('code', 'tip-head', C.formatIP(ip)));
        if (!at) {
            var res = C.reservedAt(model, ip);
            if (res) add(into, el('div', 'tip-line', 'Reserved'), el('div', 'tip-note', 'IPReservation ' + res.name + ' · ' + res.text));
            else add(into, el('div', 'tip-line ok', 'Free'), el('div', 'tip-note', 'in ' + block.cidr));
            return true;
        }
        if (at.tunnel) {
            add(into, el('div', 'tip-line', at.tunnel + ' address'), el('div', 'tip-note', 'of node ' + (at.node || block.node)));
            return true;
        }
        var line = el('div', 'tip-line');
        var d = el('i', 'dot');
        d.style.background = model.colors[at.namespace] || 'var(--k-faint)';
        add(line, d, el('strong', '', at.pod || at.vmi || at.handle || 'unknown owner'), at.namespace ? el('span', 'faint', ' · ' + at.namespace) : null);
        into.appendChild(line);
        if (at.node) into.appendChild(el('div', 'tip-note', 'on ' + at.node + (at.borrowed ? ' — borrowed from ' + block.node : '')));
        if (at.released) into.appendChild(el('div', 'tip-note', 'released, cooling down'));
        if (at.pod && !at.podRef) into.appendChild(el('div', 'tip-note warn-text', 'no such pod now — possibly leaked'));
        return true;
    }

    // ----- the tooltip -------------------------------------------------------------

    // One floating tip for the page, filled by `describe` for whatever matches
    // `selector` under the pointer.
    function tooltip(root, selector, describe) {
        var tip = el('div', 'tip');
        tip.hidden = true;
        tip.setAttribute('role', 'tooltip');
        document.body.appendChild(tip);

        function place(event) {
            var pad = 14;
            var w = tip.offsetWidth;
            var h = tip.offsetHeight;
            var x = event.clientX + pad;
            var y = event.clientY + pad;
            if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
            if (y + h > window.innerHeight - 8) y = event.clientY - h - pad;
            tip.style.left = Math.max(8, x) + 'px';
            tip.style.top = Math.max(8, y) + 'px';
        }

        root.addEventListener('pointerover', function (event) {
            var target = event.target.closest && event.target.closest(selector);
            if (!target || !root.contains(target)) return;
            tip.textContent = '';
            if (!describe(target, tip)) {
                tip.hidden = true;
                return;
            }
            tip.hidden = false;
            place(event);
        });
        root.addEventListener('pointermove', function (event) {
            if (!tip.hidden) place(event);
        });
        root.addEventListener('pointerout', function (event) {
            var target = event.target.closest && event.target.closest(selector);
            if (target && !target.contains(event.relatedTarget)) tip.hidden = true;
        });
        return tip;
    }

    // ----- the grip ----------------------------------------------------------------

    // A grab strip on the inner edge of a panel on the right: drag it, or
    // focus it and use the arrow keys, to make the panel wider or narrower; a
    // double-click puts it back. The width is a custom property on the root.
    // opts: { panel, prop, min, room, initial, label, className, onResize(px, done) }
    function grip(opts) {
        var root = document.documentElement;
        var node = el('div', 'grip' + (opts.className ? ' ' + opts.className : ''));
        node.tabIndex = 0;
        node.title = 'Drag to resize · double-click to reset';
        node.setAttribute('role', 'separator');
        node.setAttribute('aria-orientation', 'vertical');
        node.setAttribute('aria-label', opts.label || 'Resize the panel');
        var wanted = opts.initial > 0 ? opts.initial : 0;
        var drag = null;
        var frame = 0;

        function fit(px) {
            return Math.round(Math.max(opts.min, Math.min(px, window.innerWidth - opts.room)));
        }
        function apply() {
            if (wanted) root.style.setProperty(opts.prop, fit(wanted) + 'px');
            else root.style.removeProperty(opts.prop);
        }
        function tell(done) {
            if (!opts.onResize) return;
            cancelAnimationFrame(frame);
            frame = 0;
            if (done) opts.onResize(wanted, true);
            else
                frame = requestAnimationFrame(function () {
                    frame = 0;
                    opts.onResize(wanted, false);
                });
        }
        function resize(px, done) {
            wanted = px ? fit(px) : 0;
            apply();
            tell(done);
        }
        function release(event) {
            if (!drag) return;
            drag = null;
            document.body.classList.remove('gripping');
            if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
            tell(true);
        }
        node.addEventListener('pointerdown', function (event) {
            if (event.button !== 0) return;
            event.preventDefault();
            node.setPointerCapture(event.pointerId);
            drag = { x: event.clientX, from: opts.panel.getBoundingClientRect().width };
            document.body.classList.add('gripping');
        });
        node.addEventListener('pointermove', function (event) {
            if (drag) resize(drag.from + drag.x - event.clientX, false);
        });
        node.addEventListener('pointerup', release);
        node.addEventListener('pointercancel', release);
        node.addEventListener('dblclick', function () {
            resize(0, true);
        });
        node.addEventListener('keydown', function (event) {
            var step = event.shiftKey ? 48 : 16;
            var now = wanted || opts.panel.getBoundingClientRect().width;
            if (event.key === 'ArrowLeft') resize(now + step, true);
            else if (event.key === 'ArrowRight') resize(now - step, true);
            else return;
            event.preventDefault();
        });
        window.addEventListener('resize', function () {
            if (!wanted) return;
            apply();
            tell(false);
        });
        apply();
        return node;
    }

    // ----- page state --------------------------------------------------------------

    // Switching tabs unloads a page; what it was showing lives in the hash.
    function readHash() {
        var out = {};
        String(location.hash || '')
            .replace(/^#/, '')
            .split('&')
            .forEach(function (kv) {
                var cut = kv.indexOf('=');
                if (cut > 0) {
                    try {
                        out[kv.slice(0, cut)] = decodeURIComponent(kv.slice(cut + 1));
                    } catch (e) {
                        // a mangled value is dropped
                    }
                }
            });
        return out;
    }

    function writeHash(values) {
        var parts = [];
        Object.keys(values).forEach(function (k) {
            var v = values[k];
            if (v === '' || v === null || v === undefined || v === false || v === 0) return;
            parts.push(k + '=' + encodeURIComponent(String(v)));
        });
        try {
            history.replaceState(null, '', '#' + parts.join('&'));
        } catch (e) {
            // A frame that may not touch its history keeps the state in memory.
        }
    }

    // Kept between sessions where the app can keep it (0.0.19+).
    var store = {
        get: function (sdk, key) {
            if (!sdk.storage) return Promise.resolve(null);
            return sdk.storage.get(key).catch(function () {
                return null;
            });
        },
        set: function (sdk, key, value) {
            if (!sdk.storage) return;
            sdk.storage.set(key, value).catch(function () {});
        },
    };

    function every(ms, fn, onError) {
        function run() {
            Promise.resolve()
                .then(fn)
                .catch(onError || function () {})
                .then(function () {
                    setTimeout(run, ms);
                });
        }
        run();
    }

    // ----- asking the app to change something ----------------------------------

    function declined(err) {
        return /declined/i.test((err && err.message) || '');
    }

    function apply(sdk, ref, patch) {
        return sdk.patch({ kind: ref.kind, namespace: ref.namespace, name: ref.name, patch: patch }).then(
            function () {
                return true;
            },
            function (err) {
                if (declined(err)) return false;
                throw err;
            },
        );
    }

    function create(sdk, request) {
        return sdk.create(request).then(
            function (res) {
                return res || { name: '' };
            },
            function (err) {
                if (declined(err)) return null;
                throw err;
            },
        );
    }

    // The standard first step for an open namespace.
    function isolate(sdk, namespace) {
        return create(sdk, {
            kind: C.KINDS.knps,
            namespace: namespace,
            object: {
                apiVersion: 'networking.k8s.io/v1',
                kind: 'NetworkPolicy',
                metadata: { name: 'default-deny-ingress', namespace: namespace },
                spec: { podSelector: {}, policyTypes: ['Ingress'] },
            },
        });
    }

    // ----- not installed -----------------------------------------------------------

    function absent(sdk, ctx, model, summary, onError) {
        var box = el('div', 'absent');
        var art = el('div', 'empty-art');
        art.appendChild(icon('logo'));
        box.appendChild(art);
        var unreachable = summary && !summary.checked;
        box.appendChild(el('h2', '', unreachable ? 'This cluster did not answer' : 'Calico is not installed in ' + ctx.contextName));
        box.appendChild(
            el(
                'p',
                'faint',
                unreachable
                    ? 'Whether Calico is here could not be checked, which is not the same as it being absent. ' + (summary.error || '')
                    : 'This cluster does not serve the crd.projectcalico.org kinds every Calico install has, so its pod network and network policy come from something else.',
            ),
        );
        if (summary && summary.requirements && summary.requirements.length) {
            box.appendChild(requirementList(summary.requirements));
        } else if (model && model.missing) {
            box.appendChild(el('p', 'faint small', model.missing));
        }
        if (!unreachable) {
            box.appendChild(
                button('How to install Calico', 'primary', 'open', function () {
                    sdk.openUrl('https://docs.tigera.io/calico/latest/getting-started/kubernetes/').catch(onError);
                }),
            );
        }
        return box;
    }

    // The kinds Calico needs, then the optional ones folded away: a missing
    // install is explained by the first six, not by all of them.
    function requirementList(reqs) {
        var wrap = el('div', 'req-wrap');
        function row(r) {
            var item = el('li', r.served ? 'ok' : r.optional ? 'muted' : 'error');
            add(item, icon(r.served ? 'check' : 'close'), el('span', 'req-label', r.label), el('code', 'faint', r.kind.replace(/^crd:/, '')));
            item.title = r.error || r.kind;
            return item;
        }
        var list = el('ul', 'req-list');
        reqs.filter(function (r) {
            return !r.optional;
        }).forEach(function (r) {
            list.appendChild(row(r));
        });
        wrap.appendChild(list);
        var optional = reqs.filter(function (r) {
            return r.optional;
        });
        if (optional.length) {
            var served = optional.filter(function (r) {
                return r.served;
            }).length;
            var more = el('details', 'req-more');
            more.appendChild(el('summary', '', plural(optional.length, 'optional kind') + ' — ' + (served ? served + ' served' : 'none served')));
            var ol = el('ul', 'req-list');
            optional.forEach(function (r) {
                ol.appendChild(row(r));
            });
            more.appendChild(ol);
            wrap.appendChild(more);
        }
        return wrap;
    }

    // ----- charts ------------------------------------------------------------------

    var FALLBACK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

    function seriesColor(i) {
        return 'var(--chart-' + Math.min(i + 1, 8) + ', ' + FALLBACK[Math.min(i, 7)] + ')';
    }

    function formatValue(v, unit) {
        if (!isFinite(v)) return '—';
        if (unit === 'count') return String(Math.round(v));
        if (unit === 'seconds') {
            if (v < 0.001) return Math.round(v * 1e6) + ' µs';
            if (v < 1) return Math.round(v * 1000) + ' ms';
            return Math.round(v * 10) / 10 + ' s';
        }
        if (unit === 'ops/s') return (Math.round(v * 100) / 100).toString() + '/s';
        if (unit === 'percent') return Math.round(v * 100) + '%';
        return Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
    }

    // One chart as an area per series from zero, a gap where Prometheus had
    // no sample, and each series' latest value in the legend.
    function sparkChart(chart, colorOf) {
        colorOf = colorOf || function (name, i) {
            return seriesColor(i);
        };
        var card = el('article', 'ov-chart');
        var head = el('div', 'ov-chart-head');
        head.appendChild(el('h3', '', chart.label));
        if (chart.description) head.title = chart.description;
        card.appendChild(head);
        var series = (chart.series || []).filter(function (s) {
            return s.points.length > 0;
        });
        if (chart.error || series.length === 0) {
            card.appendChild(el('p', 'ov-quiet', chart.error || 'No data for this window. ' + (chart.description || '')));
            return card;
        }
        var minT = Infinity;
        var maxT = -Infinity;
        var maxV = 0;
        series.forEach(function (s) {
            s.points.forEach(function (p) {
                minT = Math.min(minT, p.t);
                maxT = Math.max(maxT, p.t);
                if (isFinite(p.v)) maxV = Math.max(maxV, p.v);
            });
        });
        if (maxT === minT) maxT = minT + 1;
        var top = maxV > 0 ? maxV * 1.15 : 1;
        var W = 600;
        var H = 140;
        var x = function (t) {
            return ((t - minT) / (maxT - minT)) * W;
        };
        var y = function (v) {
            return H - (Math.max(0, v) / top) * H;
        };
        var step = (maxT - minT) / 60;
        var plot = el('div', 'ov-plot');
        var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', class: 'ov-spark' });
        [0.25, 0.5, 0.75].forEach(function (f) {
            s.appendChild(svg('line', { x1: 0, x2: W, y1: H * f, y2: H * f, class: 'ov-grid' }));
        });
        series.forEach(function (sr, i) {
            var runs = [];
            var run = [];
            sr.points.forEach(function (p, j) {
                var gap = j > 0 && p.t - sr.points[j - 1].t > step * 3;
                if (!isFinite(p.v) || gap) {
                    if (run.length) runs.push(run);
                    run = [];
                    if (!isFinite(p.v)) return;
                }
                run.push(p);
            });
            if (run.length) runs.push(run);
            var colour = colorOf(sr.name, i);
            runs.forEach(function (r) {
                var line = r
                    .map(function (p, j) {
                        return (j ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1);
                    })
                    .join(' ');
                var area = svg('path', { d: line + ' L' + x(r[r.length - 1].t).toFixed(1) + ' ' + H + ' L' + x(r[0].t).toFixed(1) + ' ' + H + ' Z', class: 'ov-area' });
                area.style.fill = colour;
                s.appendChild(area);
                var stroke = svg('path', { d: line, class: 'ov-line' });
                stroke.style.stroke = colour;
                s.appendChild(stroke);
            });
        });
        plot.appendChild(s);
        plot.appendChild(el('span', 'ov-plot-top', formatValue(maxV, chart.unit)));
        card.appendChild(plot);
        var legend = el('div', 'ov-chart-legend');
        series.slice(0, 8).forEach(function (sr, i) {
            var last = sr.points[sr.points.length - 1];
            var key = el('span', 'ov-chart-key');
            var d = el('i', 'dot');
            d.style.background = colorOf(sr.name, i);
            add(key, d, el('span', '', sr.name || chart.label), el('strong', '', formatValue(last.v, chart.unit)));
            legend.appendChild(key);
        });
        if (series.length > 8) legend.appendChild(el('span', 'faint', '+' + (series.length - 8) + ' more'));
        card.appendChild(legend);
        return card;
    }

    window.CalicoKit = {
        el: el,
        add: add,
        svg: svg,
        icon: icon,
        logo: logo,
        chip: chip,
        sdot: sdot,
        button: button,
        iconButton: iconButton,
        link: link,
        about: about,
        plural: plural,
        ring: ring,
        meter: meter,
        usage: usage,
        fillTone: fillTone,
        age: age,
        ago: ago,
        kindBadge: kindBadge,
        actionPill: actionPill,
        pips: pips,
        part: part,
        ruleFlow: ruleFlow,
        selectorCode: selectorCode,
        policyLine: policyLine,
        orderText: orderText,
        shortCIDR: shortCIDR,
        blockTile: blockTile,
        seatMap: seatMap,
        describeSeat: describeSeat,
        tooltip: tooltip,
        grip: grip,
        readHash: readHash,
        writeHash: writeHash,
        store: store,
        every: every,
        apply: apply,
        create: create,
        isolate: isolate,
        absent: absent,
        requirementList: requirementList,
        seriesColor: seriesColor,
        formatValue: formatValue,
        sparkChart: sparkChart,
    };
})();
