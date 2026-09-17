# Calico for K8s Dockside

A plugin for the [K8s Dockside](https://github.com/rogerwesterbo/k8sdockside)
desktop app that shows [Calico](https://www.tigera.io/project-calico/) as what it
does: pod addresses, routing and network policy. Plain HTML and script, no build
step. Needs **K8s Dockside 0.0.27 or newer**; Prometheus is optional, for charts.

## What it shows

- **Overview** — a verdict, the IPAM ring per pool, how the network is built
  (dataplane, encapsulation, BGP, WireGuard, NAT, Typha, API server, flow logs,
  MTU), operator status, calico-node on every node, what needs attention,
  Calico's recent events and its charts.
- **Policy board** — every tier as a lane in evaluation order, policies as cards
  on an order ruler with their rules as pips, a drawer that reads a policy rule
  by rule, **Trace** to follow one pod's traffic through the tiers, and an
  **Isolate** button for namespaces no policy protects.
- **IP address management** — every pool with its usage and a map of its IPAM
  blocks by node; a block opens as a seat map of its addresses.
- **Routing & BGP** — the node mesh, route reflectors and external peers, with
  session state from CalicoNodeStatus; the VXLAN overlay when BGP is off.
- **Flow logs** — what Whisker (Calico 3.30+) saw in the last minute to hour:
  who talks to whom namespace to namespace, what is denied and by which policy,
  a timeline, and every flow with its policy trace, live.
- **Panels** on Pods, IP pools, Calico/Global/Kubernetes (and staged) network
  policies, and **tables** for every Calico kind and Calico's own pods.

## Installing

**Settings → Plugins → From a repository** with:

```
https://github.com/rogerwesterbo/k8sdockside-calico.git
```

## What it reads, and what it may change

It reads the `crd.projectcalico.org` kinds every Calico install has (not the
aggregated `projectcalico.org/v3` API), the `operator.tigera.io` kinds when the
operator is used, and Pods, Nodes, Namespaces, Services, NetworkPolicies and
Events. Selectors are evaluated in the page with a port of Calico's own parser.

Flow logs come from Whisker's `GET /whisker-backend/flows`, which the app
calls through the API server's service proxy (`calico-system/whisker`, port
8081 up to Calico 3.32, 8443 over https from 3.33). That needs `get` on
`services/proxy`, and the operator's deny-all policy on the whisker pod has to
let the nodes in — the page explains both when they get in the way.

It asks for three changes, and the app shows each before it is made:

- **Isolate** — a Kubernetes NetworkPolicy `default-deny-ingress`
  (`podSelector: {}`, `policyTypes: [Ingress]`) in one namespace.
- **Turn on flow logs** — the operator's `Goldmane` and `Whisker` named
  `default`, when Whisker does not run.
- **Let the nodes in** — a Kubernetes NetworkPolicy
  `calico-system/k8sdockside-whisker-from-nodes` allowing the nodes' addresses
  to Whisker's port, when a Kubernetes policy guards it (Calico 3.30–3.31).
  From 3.32 the page shows a Calico policy to apply yourself.

It never writes `crd.projectcalico.org` objects.

## Layout

```
plugin.json          the manifest
ui/selector.js       Calico's selector language and Kubernetes label selectors
ui/model.js          reads the cluster and works out pools, blocks, policy, BGP
ui/kit.js            icons, gauges, rule flows, block tiles, seat maps, grip
ui/calico.css        one stylesheet on the app's theme tokens
ui/overview.*        the overview           ui/index.html, policies.js  policy board
ui/ipam.*            IP address management  ui/routing.*                routing & BGP
ui/flows.*           flow logs from Whisker
ui/pod.* policy.* ippool.*                  detail panels
```

`go run github.com/rogerwesterbo/k8sdockside/cmd/plugincheck@main .` checks it,
as CI does.
