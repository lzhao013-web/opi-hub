// 仅按已知路径分组，不解析本机文件系统；叶节点始终保留设备上报的原始路径。
function splitPath(path) {
  const drive = path.match(/^[a-z]:[\\/]/i);
  const share = path.match(/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/);
  const prefix = drive?.[0] ?? share?.[0] ?? (path.startsWith("/") ? "/" : "");
  const windows = Boolean(drive || share);
  const separator = windows && prefix.includes("\\") ? "\\" : "/";
  const root = prefix && !prefix.endsWith(separator) ? prefix + separator : prefix;
  return { root, separator, parts: path.slice(prefix.length).split(windows ? /[\\/]+/ : /\/+/).filter(Boolean) };
}

export function buildWorkspaceTree(paths) {
  const roots = new Map();
  for (const path of new Set(paths)) {
    const { root, separator, parts } = splitPath(path);
    const segments = [root]; const rootKey = JSON.stringify(segments);
    if (!roots.has(rootKey)) roots.set(rootKey, { key: rootKey, label: root, path: root, workspace: null, children: new Map(), separator });
    let node = roots.get(rootKey);
    for (const part of parts) {
      segments.push(part);
      if (!node.children.has(part)) {
        const prefix = node.path && !node.path.endsWith(separator) ? node.path + separator : node.path;
        node.children.set(part, { key: JSON.stringify(segments), label: part, path: prefix + part, workspace: null, children: new Map(), separator });
      }
      node = node.children.get(part);
    }
    node.workspace = path;
  }
  const compact = (start) => {
    let node = start; let label = node.label;
    // 不跨过真实工作区压缩，父工作区仍可独立进入。
    while (node.workspace === null && node.children.size === 1) {
      const child = node.children.values().next().value;
      label += label && !label.endsWith(node.separator) ? node.separator + child.label : child.label;
      node = child;
    }
    return { key: node.key, label, path: node.path, workspace: node.workspace, children: sorted(node.children).map(compact) };
  };
  const sorted = (nodes) => [...nodes.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN", { numeric: true }));
  // 未注册为工作区的 POSIX 根只用于分组，不额外占用一层缩进。
  return sorted(roots).flatMap((root) => root.label === "/" && root.workspace === null
    ? sorted(root.children).map((child) => compact({ ...child, label: "/" + child.label }))
    : [compact(root)]);
}

export function workspaceAncestors(nodes, path) {
  for (const node of nodes) {
    if (node.workspace === path) return [node.key];
    const found = workspaceAncestors(node.children, path);
    if (found.length) return [node.key, ...found];
  }
  return [];
}
