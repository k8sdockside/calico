// Calico's selector language, parsed and evaluated here the way calico-node
// does it (libcalico-go/lib/selector: tokenizer.go, parser.go, ast.go), so the
// pages can say which workloads a policy selects without asking anyone.
//
//   label == "v"   label != "v"      (!= also matches when the label is absent)
//   label in {"a", "b"}   label not in {"a"}   (not in also matches when absent)
//   label contains "v"   label starts with "v"   label ends with "v"
//   has(label)   !expr   expr && expr   expr || expr   ( expr )
//   all()  -- and the empty selector -- match everything
//   global() matches like all(); as a namespaceSelector it means "not in any
//   namespace": global network sets and host endpoints.
//
// Plus Kubernetes LabelSelectors, for networking.k8s.io NetworkPolicies.
(function () {
    'use strict';

    var MAX_LABEL = 512;
    var CACHE_MAX = 5000;
    var cache = new Map();

    // ----- tokens ------------------------------------------------------------

    function identChar(c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '.' || c === '/' || c === '-';
    }

    function trim(s) {
        var i = 0;
        while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
        return s.slice(i);
    }

    function boundary(s) {
        return s === '' || !identChar(s[0]);
    }

    function cutWord(s, word) {
        if (s.indexOf(word) !== 0) return null;
        var rest = s.slice(word.length);
        return boundary(rest) ? rest : null;
    }

    function cutWords(s, words) {
        var rest = s;
        for (var i = 0; i < words.length; i++) {
            if (rest.indexOf(words[i]) !== 0) return null;
            rest = trim(rest.slice(words[i].length));
        }
        return boundary(rest) ? rest : null;
    }

    function cutIdent(s) {
        var i = 0;
        while (i < s.length && identChar(s[i])) i++;
        if (i === 0) throw new Error('expected a label name at "' + s.slice(0, 12) + '"');
        if (i > MAX_LABEL) throw new Error('label too long');
        return { ident: s.slice(0, i), rest: s.slice(i) };
    }

    function tokenize(input) {
        var toks = [];
        var s = input;
        for (;;) {
            var start = s.length;
            s = trim(s);
            if (!s.length) {
                toks.push({ k: 'eof' });
                return toks;
            }
            var last = toks.length ? toks[toks.length - 1].k : '';
            var c = s[0];
            var rest;
            if (c === '(') {
                toks.push({ k: '(' });
                s = s.slice(1);
            } else if (c === ')') {
                toks.push({ k: ')' });
                s = s.slice(1);
            } else if (c === '"' || c === "'") {
                var end = s.indexOf(c, 1);
                if (end < 0) throw new Error('unterminated string');
                toks.push({ k: 'str', v: s.slice(1, end) });
                s = s.slice(end + 1);
            } else if (c === '{') {
                toks.push({ k: '{' });
                s = s.slice(1);
            } else if (c === '}') {
                toks.push({ k: '}' });
                s = s.slice(1);
            } else if (c === ',') {
                toks.push({ k: ',' });
                s = s.slice(1);
            } else if (c === '=') {
                if (s.indexOf('==') !== 0) throw new Error('expected ==');
                toks.push({ k: '==' });
                s = s.slice(2);
            } else if (c === '!') {
                if (s.indexOf('!=') === 0) {
                    toks.push({ k: '!=' });
                    s = s.slice(2);
                } else {
                    toks.push({ k: '!' });
                    s = s.slice(1);
                }
            } else if (c === '&') {
                if (s.indexOf('&&') !== 0) throw new Error('expected &&');
                toks.push({ k: '&&' });
                s = s.slice(2);
            } else if (c === '|') {
                if (s.indexOf('||') !== 0) throw new Error('expected ||');
                toks.push({ k: '||' });
                s = s.slice(2);
            } else if (last === 'label') {
                // After a label, only an operator may follow.
                if ((rest = cutWord(s, 'contains')) !== null) toks.push({ k: 'contains' });
                else if ((rest = cutWords(s, ['starts', 'with'])) !== null) toks.push({ k: 'starts' });
                else if ((rest = cutWords(s, ['ends', 'with'])) !== null) toks.push({ k: 'ends' });
                else if ((rest = cutWords(s, ['not', 'in'])) !== null) toks.push({ k: 'notin' });
                else if ((rest = cutWord(s, 'in')) !== null) toks.push({ k: 'in' });
                else throw new Error('expected an operator after label "' + toks[toks.length - 1].v + '"');
                s = rest;
            } else if (s.indexOf('has(') === 0) {
                var id = cutIdent(trim(s.slice(4)));
                rest = trim(id.rest);
                if (rest[0] !== ')') throw new Error("no closing ')' after has(");
                toks.push({ k: 'has', v: id.ident });
                s = rest.slice(1);
            } else if (s.indexOf('all(') === 0) {
                rest = trim(s.slice(4));
                if (rest[0] !== ')') throw new Error("no closing ')' after all(");
                toks.push({ k: 'all' });
                s = rest.slice(1);
            } else if (s.indexOf('global(') === 0) {
                rest = trim(s.slice(7));
                if (rest[0] !== ')') throw new Error("no closing ')' after global(");
                toks.push({ k: 'global' });
                s = rest.slice(1);
            } else {
                var ident = cutIdent(s);
                toks.push({ k: 'label', v: ident.ident });
                s = ident.rest;
            }
            if (s.length >= start) throw new Error('could not read the selector');
        }
    }

    // ----- the parser --------------------------------------------------------
    // Each node is { ev(labels) -> bool, global?: true, all?: true }.

    function has(labels, key) {
        return Object.prototype.hasOwnProperty.call(labels, key);
    }

    function parseOr(t, i) {
        var first = parseAnd(t, i);
        var parts = [first.node];
        i = first.i;
        while (t[i].k === '||') {
            var next = parseAnd(t, i + 1);
            parts.push(next.node);
            i = next.i;
        }
        if (parts.length === 1) return { node: parts[0], i: i };
        return {
            node: {
                ev: function (l) {
                    for (var p = 0; p < parts.length; p++) if (parts[p].ev(l)) return true;
                    return false;
                },
                all: parts.some(function (p) {
                    return p.all;
                }),
            },
            i: i,
        };
    }

    function parseAnd(t, i) {
        var first = parseOp(t, i);
        var parts = [first.node];
        i = first.i;
        while (t[i].k === '&&') {
            var next = parseOp(t, i + 1);
            parts.push(next.node);
            i = next.i;
        }
        if (parts.length === 1) return { node: parts[0], i: i };
        return {
            node: {
                ev: function (l) {
                    for (var p = 0; p < parts.length; p++) if (!parts[p].ev(l)) return false;
                    return true;
                },
            },
            i: i,
        };
    }

    function parseOp(t, i) {
        var negated = false;
        while (t[i].k === '!') {
            negated = !negated;
            i++;
        }
        var tok = t[i];
        var node;
        if (tok.k === 'has') {
            node = {
                ev: function (l) {
                    return has(l, tok.v);
                },
            };
            i++;
        } else if (tok.k === 'all') {
            node = { ev: yes, all: true };
            i++;
        } else if (tok.k === 'global') {
            node = { ev: yes, global: true };
            i++;
        } else if (tok.k === 'label') {
            var op = t[i + 1];
            var key = tok.v;
            if (!op || op.k === 'eof') throw new Error('unexpected end of selector after "' + key + '"');
            if (op.k === 'in' || op.k === 'notin') {
                if (t[i + 2].k !== '{') throw new Error('expected a set literal { … } after "' + key + ' ' + (op.k === 'in' ? 'in' : 'not in') + '"');
                var j = i + 3;
                var set = {};
                while (t[j].k === 'str') {
                    set[t[j].v] = true;
                    j++;
                    if (t[j].k === ',') j++;
                    else break;
                }
                if (t[j].k !== '}') throw new Error('expected }');
                i = j + 1;
                node =
                    op.k === 'in'
                        ? {
                              ev: function (l) {
                                  return has(l, key) && set[l[key]] === true;
                              },
                          }
                        : {
                              ev: function (l) {
                                  return !has(l, key) || set[l[key]] !== true;
                              },
                          };
            } else {
                var lit = t[i + 2];
                if (['==', '!=', 'contains', 'starts', 'ends'].indexOf(op.k) < 0) throw new Error('expected == or != after "' + key + '"');
                if (!lit || lit.k !== 'str') throw new Error('expected a quoted string after "' + key + ' ' + opText(op.k) + '"');
                var v = lit.v;
                i += 3;
                node = {
                    ev: {
                        '==': function (l) {
                            return has(l, key) && l[key] === v;
                        },
                        '!=': function (l) {
                            return !has(l, key) || l[key] !== v;
                        },
                        contains: function (l) {
                            return has(l, key) && String(l[key]).indexOf(v) >= 0;
                        },
                        starts: function (l) {
                            return has(l, key) && String(l[key]).indexOf(v) === 0;
                        },
                        ends: function (l) {
                            var s = has(l, key) ? String(l[key]) : null;
                            return s !== null && s.length >= v.length && s.slice(s.length - v.length) === v;
                        },
                    }[op.k],
                };
            }
        } else if (tok.k === '(') {
            var inner = parseOr(t, i + 1);
            if (t[inner.i].k !== ')') throw new Error('expected )');
            node = inner.node;
            i = inner.i + 1;
        } else {
            throw new Error(tok.k === 'eof' ? 'unexpected end of selector' : 'unexpected "' + (tok.v || tok.k) + '"');
        }
        if (negated) {
            var base = node;
            node = {
                ev: function (l) {
                    return !base.ev(l);
                },
            };
        }
        return { node: node, i: i };
    }

    function opText(k) {
        return { starts: 'starts with', ends: 'ends with', notin: 'not in' }[k] || k;
    }

    function yes() {
        return true;
    }

    function no() {
        return false;
    }

    // parse(text) -> { text, ok, error, all, global, empty, ev(labels) }.
    // A selector that does not parse is reported, never thrown: ev() is then
    // false for everything, as Calico would refuse to program it.
    function parse(text) {
        text = text === undefined || text === null ? '' : String(text);
        var hit = cache.get(text);
        if (hit) return hit;
        var out = { text: text, ok: true, error: '', all: false, global: false, empty: false, ev: yes };
        try {
            var toks = tokenize(text);
            if (toks[0].k === 'eof') {
                out.all = true;
                out.empty = true;
            } else {
                var r = parseOr(toks, 0);
                if (toks[r.i].k !== 'eof') throw new Error('unexpected content at the end of the selector');
                out.ev = r.node.ev;
                out.all = !!r.node.all;
                out.global = !!r.node.global;
            }
        } catch (err) {
            out.ok = false;
            out.error = err.message;
            out.ev = no;
        }
        if (cache.size >= CACHE_MAX) cache.clear();
        cache.set(text, out);
        return out;
    }

    function matches(text, labels) {
        return parse(text).ev(labels || {});
    }

    // ----- Kubernetes LabelSelectors -----------------------------------------

    // An empty selector selects everything, as it does in the API; a nil one
    // is passed as null and selects everything too, for a podSelector.
    function k8s(selector, labels) {
        if (!selector) return true;
        labels = labels || {};
        var match = selector.matchLabels || {};
        for (var key in match) {
            if (labels[key] !== match[key]) return false;
        }
        var exprs = selector.matchExpressions || [];
        for (var i = 0; i < exprs.length; i++) {
            var e = exprs[i];
            var present = has(labels, e.key);
            var values = e.values || [];
            switch (e.operator) {
                case 'In':
                    if (!present || values.indexOf(labels[e.key]) < 0) return false;
                    break;
                case 'NotIn':
                    if (present && values.indexOf(labels[e.key]) >= 0) return false;
                    break;
                case 'Exists':
                    if (!present) return false;
                    break;
                case 'DoesNotExist':
                    if (present) return false;
                    break;
                default:
                    return false;
            }
        }
        return true;
    }

    function k8sEmpty(selector) {
        return !selector || (!Object.keys(selector.matchLabels || {}).length && !(selector.matchExpressions || []).length);
    }

    // "app=web, tier in (a, b), !debug" -- how kubectl writes one.
    function k8sText(selector) {
        if (k8sEmpty(selector)) return '';
        var parts = [];
        var match = selector.matchLabels || {};
        Object.keys(match)
            .sort()
            .forEach(function (k) {
                parts.push(k + '=' + match[k]);
            });
        (selector.matchExpressions || []).forEach(function (e) {
            var vals = (e.values || []).join(', ');
            if (e.operator === 'In') parts.push(e.key + ' in (' + vals + ')');
            else if (e.operator === 'NotIn') parts.push(e.key + ' notin (' + vals + ')');
            else if (e.operator === 'Exists') parts.push(e.key);
            else if (e.operator === 'DoesNotExist') parts.push('!' + e.key);
            else parts.push(e.key + ' ' + e.operator + ' (' + vals + ')');
        });
        return parts.join(', ');
    }

    // The Calico selector Calico itself writes for a Kubernetes one
    // (libcalico-go conversion.k8sSelectorToCalico).
    function k8sToCalico(selector, pod) {
        var parts = pod ? ["projectcalico.org/orchestrator == 'k8s'"] : [];
        if (!selector) return parts.join(' && ');
        if (!pod && k8sEmpty(selector)) return 'all()';
        var match = selector.matchLabels || {};
        Object.keys(match)
            .sort()
            .forEach(function (k) {
                parts.push(k + " == '" + match[k] + "'");
            });
        (selector.matchExpressions || []).forEach(function (e) {
            var vals = "'" + (e.values || []).join("', '") + "'";
            if (e.operator === 'In') parts.push(e.key + ' in { ' + vals + ' }');
            else if (e.operator === 'NotIn') parts.push(e.key + ' not in { ' + vals + ' }');
            else if (e.operator === 'Exists') parts.push('has(' + e.key + ')');
            else if (e.operator === 'DoesNotExist') parts.push('! has(' + e.key + ')');
        });
        return parts.join(' && ');
    }

    window.CalicoSelector = {
        parse: parse,
        matches: matches,
        tokenize: tokenize,
        k8s: k8s,
        k8sEmpty: k8sEmpty,
        k8sText: k8sText,
        k8sToCalico: k8sToCalico,
    };
})();
