# Grant access to a T3 workspace

The Factory environment holds the owner's portfolio checkout and authorized
tools. Give each startup its own T3 server, namespace, service account, PVC
and pairing. Every thread in a server can use that server's files, identity
and configured tools, including commands invoked from an agent shell.

## Render a startup workspace

From the Factory root, create an owner overlay alongside `t3-workspace`. This
example puts a startup's service account, Deployment, Service and claim in a
fresh namespace. They each use the name `t3-workspace` in that namespace.

```sh
mkdir -p sandbox/t3-owner/example-app
cat > sandbox/t3-owner/example-app/kustomization.yaml <<'YAML'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: example-app-t3
resources:
  - ../../t3-workspace/profiles/startup
components:
  - ../../t3-workspace/access/local-api
YAML
kubectl kustomize sandbox/t3-owner/example-app
```

For the Factory, reference `../../t3-workspace` and use its own namespace
(the existing pilot uses `factory-t3-pilot`). Deploy the reviewed render
through the cluster owner's workflow. Both profiles start without mounted
Kubernetes credentials until an access component is selected.

## Kubernetes on the hosting cluster

The `local-api` component adds the `workspace-local` kubectl context with a
short-lived service-account token that Kubernetes rotates. Grant permissions
in the target **application namespace**. Set `PILOT_CONTEXT` to the hosting
context, `WORKSPACE_NS` to the workspace namespace and `TARGET_NS` to the
approved application's namespace.

The example Role allows reading Pods and Deployments. Render its grant and
the associated egress policy:

```sh
kubectl --context "${PILOT_CONTEXT:?}" -n "${TARGET_NS:?}" create --dry-run=client \
  -f sandbox/t3-workspace/access/status-role.yaml -o yaml
kubectl --context "$PILOT_CONTEXT" -n "$TARGET_NS" create rolebinding "tools-${WORKSPACE_NS:?}" \
  --role=t3-workload-status --serviceaccount="$WORKSPACE_NS:t3-workspace" \
  --dry-run=client -o yaml
node sandbox/t3-workspace/access/api-egress.mjs "$WORKSPACE_NS" --local "$PILOT_CONTEXT"
```

Apply the reviewed Role, RoleBinding and NetworkPolicy through the owner
workflow. The network rule includes the API service IP and its ready
backend IP/port pairs to accommodate service address translation. Update
it when the API addresses change. The CNI must enforce NetworkPolicy.

For the Factory, bind the **actual approved role** in each target. Replace
`--role=t3-workload-status` with an existing application Role, or use
`--clusterrole=ROLE` in a **RoleBinding** to grant its namespaced rules.
Repeat for the owner's other targets. Cluster-wide operations use a
separately authorized owner identity. Give the startup identity only its own
application grants. Keep owner secrets and privileged service accounts out
of startup namespaces. Pod creation, Deployment changes and `pods/exec`
can expose other identities, volumes and credentials in the same namespace.

Check from inside the **running workspace**, including an unauthorized
namespace for a startup:

```sh
kubectl --context "$PILOT_CONTEXT" -n "$WORKSPACE_NS" exec deploy/t3-workspace -- \
  kubectl --context workspace-local -n "$TARGET_NS" get deployments
kubectl --context "$PILOT_CONTEXT" -n "$WORKSPACE_NS" exec deploy/t3-workspace -- \
  kubectl --context workspace-local -n "${OTHER_NS:?}" auth can-i list pods
```

For a startup, the second check must return `no` and exit 1 for the
out-of-scope namespace. If it returns `yes`, correct the credentials or
bindings and repeat the check before pairing the startup user.

## Other clusters and tools

Add `../../t3-workspace/access/remote-api` to the owner's overlay. It mounts
the Secret `t3-remote-kubeconfig` from **that workspace's namespace**. Issue a
kubeconfig specifically for this workspace with unique context, cluster and
user names, reachable HTTPS API endpoints, trusted CAs and dedicated target
identities. Remote server-side RBAC enforces access even when a client selects
another namespace. Give the startup only its own project credentials and give
the Factory each individually authorized owner context.

Use a self-contained kubeconfig with embedded CA data or credential paths
that exist in the pod. A workstation kubeconfig using localhost tunnels or
Keychain helpers depends on that workstation. Keep the operator's kubeconfig
and SSH agent on the operator machine. Provision the workspace-specific
Secret from the private file:

```sh
kubectl --context "${PILOT_CONTEXT:?}" -n "${WORKSPACE_NS:?}" create secret generic \
  t3-remote-kubeconfig --from-file="config=${SCOPED_KUBECONFIG:?}"
```

Rotate the Secret through the owner's workflow when its credential expires.
The read-only mount uses the full Secret volume so rotations reach the pod.
Both access components can coexist. Use explicit context names. Include
every approved API in one egress rule, for example:

```sh
node sandbox/t3-workspace/access/api-egress.mjs "$WORKSPACE_NS" \
  --local "$PILOT_CONTEXT" --endpoint "${REMOTE_API_IP:?}" "${REMOTE_API_PORT:?}"
```

Omit `--local` for a remote-only workspace. Private endpoints require an
existing route from the cluster. Verify a remote grant by running
`kubectl --context REMOTE -n NAMESPACE get deployments` inside the workspace.

For GitHub, add `../../t3-workspace/access/github` to the owner's overlay.
Give the startup a repo-scoped token and give the Factory its own
owner-authorized credential. Supply the token from a private file:

```sh
kubectl --context "${PILOT_CONTEXT:?}" -n "${WORKSPACE_NS:?}" create secret generic \
  t3-github --from-file="token=${SCOPED_GITHUB_TOKEN_FILE:?}"
```

The component exposes that workspace's token to `gh` as `GH_TOKEN`. Restart
the workspace after rotating it. Inside the startup workspace, test both the
API and actual Git transport against two existing private repositories:

```sh
gh auth setup-git
gh repo view "${ALLOWED_REPO:?}"
GIT_TERMINAL_PROMPT=0 git ls-remote "https://github.com/$ALLOWED_REPO.git"
gh repo view "${DENIED_REPO:?}"
GIT_TERMINAL_PROMPT=0 git ls-remote "https://github.com/$DENIED_REPO.git"
```

Both operations must succeed for the allowed repository and fail for the
denied one. Correct unexpected access before handoff. Apply the same
separation to other CLIs, MCP servers and provider sign-ins.
