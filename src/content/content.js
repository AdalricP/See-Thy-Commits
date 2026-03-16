const PANEL_ID = "stc-root";
const TAB_ID = "commits-tab";
const REPO_PATTERN = /^\/([^/]+)\/([^/]+)(?:\/|$)/;
const SVG_NS = "http://www.w3.org/2000/svg";
const COLORS = ["#fd7f6f", "#7eb0d5", "#b2e061", "#bd7ebe", "#ffb55a", "#8bd3c7", "#beb9db"];

let bootstrapped = false;
let isCommitsTabOpen = false;
let currentView = null;
let clearHoverTimer = null;

bootstrap();

function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;

  observeLocationChanges(() => {
    ensureCommitsTab();
    if (!isCommitsTabOpen) {
      cleanupPanel();
    }
  });

  ensureCommitsTab();
}

function ensureCommitsTab() {
  if (!getRepoInfo()) return;
  if (document.getElementById(TAB_ID)) return;

  const navList = findRepoNavList();
  if (!navList) return;

  const sourceItem = Array.from(navList.children).find((child) => child.querySelector("a, [role='link'], .UnderlineNav-item"));
  if (!sourceItem) return;

  const newItem = sourceItem.cloneNode(true);
  const link = newItem.querySelector("a, .UnderlineNav-item") || newItem.firstElementChild;
  if (!link) return;

  link.id = TAB_ID;
  link.removeAttribute("href");
  link.removeAttribute("aria-current");
  link.classList.remove("selected");
  link.setAttribute("aria-disabled", "true");
  link.dataset.tabItem = TAB_ID;
  replaceTabLabel(link);
  link.addEventListener("click", openCommitsTab);

  Array.from(navList.children).forEach((child) => {
    const childLink = child.querySelector("a, .UnderlineNav-item") || child.firstElementChild;
    if (childLink && childLink.id !== TAB_ID) {
      childLink.addEventListener("click", closeCommitsTab);
    }
  });

  const insertBefore = navList.children[1] || null;
  navList.insertBefore(newItem, insertBefore);
}

function findRepoNavList() {
  return (
    document.querySelector('nav[aria-label="Repository"] ul') ||
    document.querySelector('ul[class*="UnderlineItemList"]') ||
    document.querySelector('nav[class*="LocalNavigation"] ul')
  );
}

function replaceTabLabel(link) {
  const icon = link.querySelector("svg");
  if (icon) {
    icon.setAttribute("class", "octicon octicon-git-commit");
    const path = icon.querySelector("path");
    if (path) {
      path.setAttribute("d", "M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z");
      path.setAttribute("fill-rule", "evenodd");
    }
  }

  const spans = link.querySelectorAll("span");
  if (spans.length) {
    const label = spans[spans.length - 1];
    label.textContent = "Commits";
    label.setAttribute("data-content", "Commits");
  } else {
    link.textContent = "Commits";
  }

  const counter = link.querySelector("[title], .Counter");
  if (counter) counter.remove();
}

async function openCommitsTab(event) {
  event?.preventDefault();
  const tab = document.getElementById(TAB_ID);
  if (!tab || isCommitsTabOpen) return;

  isCommitsTabOpen = true;
  tab.removeEventListener("click", openCommitsTab);
  setActiveTab();
  await showCommitsLoading();

  const repoInfo = getRepoInfo();
  if (!repoInfo) return;

  await loadAndRender(repoInfo);
}

function closeCommitsTab() {
  isCommitsTabOpen = false;
  cleanupPanel();

  const tab = document.getElementById(TAB_ID);
  if (!tab) return;
  tab.addEventListener("click", openCommitsTab);
  tab.removeAttribute("aria-current");
  tab.classList.remove("selected");
}

function setActiveTab() {
  const navList = findRepoNavList();
  const tab = document.getElementById(TAB_ID);
  if (!navList || !tab) return;

  tab.setAttribute("aria-current", "page");
  tab.classList.add("selected");

  Array.from(navList.children).forEach((child) => {
    const link = child.querySelector("a, .UnderlineNav-item") || child.firstElementChild;
    if (link && link.id !== TAB_ID) {
      link.removeAttribute("aria-current");
      link.classList.remove("selected");
    }
  });
}

async function showCommitsLoading() {
  const container = getContentView();
  if (!container) return;

  hideExistingContent(container);
  const root = ensurePanel(container);
  root.innerHTML = '<div class="stc-loading color-fg-muted">Loading commits...</div>';
}

async function loadAndRender(repoInfo) {
  const root = ensurePanel(getContentView());

  try {
    const { payload } = await sendMessage({
      type: "stc:load-commits",
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      branch: getCurrentBranchName()
    });
    await renderFromTemplates(root, payload);
  } catch (error) {
    root.innerHTML = `<div class="stc-error color-fg-danger">${escapeHtml(error instanceof Error ? error.message : "Unable to load commits.")}</div>`;
  }
}

async function renderFromTemplates(root, payload) {
  if (clearHoverTimer) {
    clearTimeout(clearHoverTimer);
    clearHoverTimer = null;
  }

  const [containerHtml, itemHtml] = await Promise.all([
    fetch(chrome.runtime.getURL("src/templates/commitsContainer.html")).then((response) => response.text()),
    fetch(chrome.runtime.getURL("src/templates/commitItem.html")).then((response) => response.text())
  ]);

  const containerWrap = document.createElement("div");
  containerWrap.innerHTML = containerHtml;
  const outside = containerWrap.querySelector("#commits-outside-container");

  const view = buildViewState(payload, outside, itemHtml);
  currentView = view;

  root.innerHTML = "";
  root.appendChild(outside);
  outside.addEventListener("mouseleave", scheduleHoverReset);

  renderGraph(view);
  renderCommitList(view);
  syncView(view);
}

function buildViewState(payload, outside, itemHtml) {
  const commits = normalizeCommits(payload.commits || []);
  const commitsAsc = [...commits].sort(compareCommitsAscending);
  const commitsBySha = new Map(commitsAsc.map((commit) => [commit.oid, commit]));
  const commitIndexBySha = new Map(commitsAsc.map((commit, index) => [commit.oid, index]));
  const branches = normalizeBranches(payload.branches || [], payload.branch, payload.repo?.default_branch, commitIndexBySha);
  const graph = buildGraphModel(commits, branches);

  return {
    payload,
    outside,
    itemHtml,
    commitsAsc,
    commitsDesc: [...commitsAsc].reverse(),
    commitsBySha,
    commitIndexBySha,
    branches,
    graph,
    graphSvg: outside.querySelector("#graphSvg"),
    branchLabels: outside.querySelector("#branchLabels"),
    commitsContainer: outside.querySelector("#commits-container"),
    listSummary: outside.querySelector("#listSummary"),
    branchLabelsMap: new Map(),
    graphNodes: new Map(),
    graphEdges: [],
    commitElements: new Map(),
    activeBranchFilter: null,
    hoveredBranch: null,
    hoveredCommit: null,
    hoveredCommitSource: null
  };
}

function normalizeCommits(commits) {
  return commits
    .filter((commit) => commit?.sha)
    .map((commit) => ({
      ...commit,
      oid: commit.sha,
      branches: dedupeValues(commit.branches || []),
      committedDate: new Date(commit.commit?.author?.date || commit.commit?.committer?.date || Date.now())
    }));
}

function normalizeBranches(branches, currentBranch, defaultBranch, commitIndexBySha) {
  return branches
    .filter((branch) => branch?.name)
    .map((branch) => ({
      ...branch,
      color: branch.color || COLORS[0],
      commitShas: dedupeValues(branch.commits || []).filter((sha) => commitIndexBySha.has(sha))
    }))
    .filter((branch) => branch.commitShas.length)
    .sort((left, right) => {
      const priority = compareBranchPriority(left, right, currentBranch, defaultBranch);
      if (priority !== 0) {
        return priority;
      }
      return (commitIndexBySha.get(right.headSha) || -1) - (commitIndexBySha.get(left.headSha) || -1);
    })
    .map((branch) => ({
      ...branch,
      commitShas: [...branch.commitShas].sort((left, right) => commitIndexBySha.get(left) - commitIndexBySha.get(right))
    }));
}

function compareBranchPriority(left, right, currentBranch, defaultBranch) {
  return getBranchPriority(right, currentBranch, defaultBranch) - getBranchPriority(left, currentBranch, defaultBranch);
}

function getBranchPriority(branch, currentBranch, defaultBranch) {
  if (branch.name === currentBranch) {
    return 2;
  }
  if (branch.name === defaultBranch) {
    return 1;
  }
  return 0;
}

function compareCommitsAscending(left, right) {
  return left.committedDate.getTime() - right.committedDate.getTime() || left.oid.localeCompare(right.oid);
}

function compareCommitsDescending(left, right) {
  return right.committedDate.getTime() - left.committedDate.getTime() || left.oid.localeCompare(right.oid);
}

function buildGraphModel(commits, branches) {
  const graphCommits = [...commits]
    .sort(compareCommitsDescending)
    .map((commit) => ({
      ...commit,
      parents: (commit.parents || []).map((parent) => ({
        node: {
          oid: parent?.sha || parent?.node?.oid
        }
      })),
      isHead: false
    }));

  const heads = buildHeads(branches);
  const { commits: coloredCommits, commitDict, lineBranches } = assignGraphColors(graphCommits, heads);
  const indexArray = buildIndexArray(coloredCommits, commitDict);
  const headOids = new Set(heads.map((head) => head.oid));

  for (const commit of coloredCommits) {
    commit.isHead = headOids.has(commit.oid);
  }

  for (const branch of branches) {
    const headCommit = commitDict[branch.headSha] || commitDict[branch.commitShas[branch.commitShas.length - 1]];
    if (headCommit?.color) {
      branch.color = headCommit.color;
    }
  }

  for (const commit of coloredCommits) {
    commit.primaryBranch =
      branches.find((branch) => branch.color === commit.color && branch.commitShas.includes(commit.oid))?.name ||
      commit.branches[0] ||
      null;
  }

  return {
    commits: coloredCommits,
    commitDict,
    indexArray,
    lineBranches
  };
}

function buildHeads(branches) {
  return branches
    .filter((branch) => branch.headSha)
    .map((branch) => ({
      name: branch.name,
      oid: branch.headSha
    }));
}

function assignGraphColors(commits, heads) {
  const headOids = new Set(heads.map((head) => head.oid));
  const commitDict = {};
  const lineBranches = new Map();
  let colorIndex = 0;
  let unassignedColors = [...COLORS];

  for (const commit of commits) {
    commit.color = undefined;
    commit.lineIndex = undefined;
    commitDict[commit.oid] = commit;
  }

  for (const baseCommit of commits) {
    const commit = commitDict[baseCommit.oid];
    if (commit.color == null || headOids.has(commit.oid)) {
      commit.color = unassignedColors[colorIndex % unassignedColors.length];
      unassignedColors = unassignedColors.filter((color) => color !== commit.color);
      if (!unassignedColors.length) {
        unassignedColors = [...COLORS];
      }
      commit.lineIndex = colorIndex;
    }
    colorIndex += 1;
    if (commit.parents.length > 0) {
      const firstParentOid = commit.parents[0].node.oid;
      if (firstParentOid in commitDict && commitDict[firstParentOid].color == null) {
        commitDict[firstParentOid].color = commit.color;
        commitDict[firstParentOid].lineIndex = commit.lineIndex;
      }
    }
  }

  for (const commit of commits) {
    const branches = lineBranches.get(commit.lineIndex) || new Set();
    for (const branchName of commit.branches || []) {
      branches.add(branchName);
    }
    lineBranches.set(commit.lineIndex, branches);
  }

  return { commits, commitDict, lineBranches };
}

function buildIndexArray(commits, commitDict) {
  const indexArray = Array.from({ length: commits.length }, () => []);

  for (let line = 0; line < commits.length; line += 1) {
    let lineBeginning = 100;
    let lineEnding = 0;

    for (let commitIndex = 0; commitIndex < commits.length; commitIndex += 1) {
      const commit = commits[commitIndex];
      let foundLineInParents = false;

      for (const parent of commit.parents) {
        const parentItem = commitDict[parent.node.oid];
        if (parentItem !== undefined && parentItem.lineIndex === line) {
          foundLineInParents = true;
        }
      }

      if (commit.lineIndex === line || foundLineInParents) {
        lineBeginning = Math.min(lineBeginning, commitIndex);
        lineEnding = Math.max(lineEnding, commitIndex);
      }
    }

    for (let index = lineBeginning; index < lineEnding; index += 1) {
      indexArray[index + 1].push(line);
    }
  }

  return indexArray;
}

function renderGraph(view) {
  const svg = view.graphSvg;
  const branchLabels = view.branchLabels;
  const columnGap = 52;
  const laneGap = 34;
  const marginX = 36;
  const marginY = 24;
  const graphCommits = view.graph.commits;
  const indexArray = view.graph.indexArray;
  const width = Math.max(480, (graphCommits.length - 1) * columnGap + marginX * 2 + 24);
  const laneCount = Math.max(
    1,
    ...graphCommits.map((commit, index) => resolveLineSlot(indexArray[index], commit.lineIndex) + 1),
    ...indexArray.map((lines) => lines.length + 1)
  );
  const height = Math.max(110, (laneCount - 1) * laneGap + marginY * 2 + 16);

  svg.innerHTML = "";
  branchLabels.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;

  view.branchLabelsMap.clear();
  view.graphNodes.clear();
  view.graphEdges = [];

  for (const branch of view.branches) {
    const label = buildBranchLabel(branch);
    branchLabels.appendChild(label);
    view.branchLabelsMap.set(branch.name, label);
    attachBranchHover(label, view, branch.name);
    label.addEventListener("click", () => toggleBranchFilter(view, branch.name));
  }

  const lineColors = [];
  for (const commit of graphCommits) {
    lineColors[commit.lineIndex] = commit.color;
  }

  for (const [index, commit] of graphCommits.entries()) {
    commit.cx = marginX + (graphCommits.length - 1 - index) * columnGap;
    commit.cy = marginY + resolveLineSlot(indexArray[index], commit.lineIndex) * laneGap;
  }

  for (let index = 0; index < graphCommits.length - 1; index += 1) {
    const commit = graphCommits[index];
    let hasVisibleParents = false;

    for (const parentItem of commit.parents) {
      const parent = view.graph.commitDict[parentItem.node.oid];
      if (parent === undefined) {
        continue;
      }

      hasVisibleParents = true;
      const nextX = graphCommits[index + 1].cx;
      const nextY = marginY + resolveLineSlot(indexArray[index + 1], parent.lineIndex) * laneGap;
      appendGraphEdge(
        view,
        svg,
        drawCurveHorizontal(commit.cx, commit.cy, nextX, nextY),
        lineColors[parent.lineIndex],
        new Set([...(view.graph.lineBranches.get(parent.lineIndex) || []), ...commit.branches, ...parent.branches])
      );
    }

    if (!hasVisibleParents) {
      appendGraphEdge(
        view,
        svg,
        drawDottedLineHorizontal(commit.cx, commit.cy),
        lineColors[commit.lineIndex],
        view.graph.lineBranches.get(commit.lineIndex) || new Set(commit.branches),
        true
      );
    }
  }

  for (let lineIndex = 0; lineIndex < graphCommits.length; lineIndex += 1) {
    for (let index = 0; index < graphCommits.length - 1; index += 1) {
      if (indexArray[index].includes(lineIndex) && indexArray[index + 1].includes(lineIndex)) {
        const currentX = graphCommits[index].cx;
        const currentY = marginY + resolveLineSlot(indexArray[index], lineIndex) * laneGap;
        const nextX = graphCommits[index + 1].cx;
        const nextY = marginY + resolveLineSlot(indexArray[index + 1], lineIndex) * laneGap;
        appendGraphEdge(
          view,
          svg,
          drawCurveHorizontal(currentX, currentY, nextX, nextY),
          lineColors[lineIndex],
          view.graph.lineBranches.get(lineIndex) || new Set()
        );
      }
    }
  }

  for (const commit of graphCommits) {
    const node = createSvgNode("circle", {
      class: `stc-graph-node${commit.isHead ? " stc-graph-node-head" : ""}`,
      cx: String(commit.cx),
      cy: String(commit.cy),
      r: commit.isHead ? "7" : "5",
      fill: commit.color,
      "data-sha": commit.oid,
      "data-primary-branch": commit.primaryBranch || "",
      "data-branches": serializeBranches(commit.branches)
    });

    node.addEventListener("mouseenter", () => setHoverState(view, commit.primaryBranch, commit.oid, "graph"));
    node.addEventListener("mouseleave", scheduleHoverReset);
    svg.appendChild(node);
    view.graphNodes.set(commit.oid, [node]);
  }
}

function buildBranchLabel(branch) {
  const label = document.createElement("button");
  label.type = "button";
  label.className = "stc-branch-label";
  label.dataset.branch = branch.name;
  label.setAttribute("aria-label", branch.name);
  label.setAttribute("title", branch.name);

  label.appendChild(createBranchLegendIcon(branch.color));

  const name = document.createElement("span");
  name.className = "stc-branch-label__name";
  name.textContent = branch.name;

  const meta = document.createElement("span");
  meta.className = "stc-branch-label__meta";

  if (branch.isCurrent) {
    meta.appendChild(buildBadge("current"));
  }

  if (branch.isDefault) {
    meta.appendChild(buildBadge("default"));
  }

  label.append(name, meta);
  return label;
}

function buildBadge(text) {
  const badge = document.createElement("span");
  badge.className = "stc-branch-badge";
  badge.textContent = text;
  return badge;
}

function createBranchLegendIcon(color) {
  const svg = createSvgNode("svg", {
    class: "stc-branch-label__icon",
    "aria-hidden": "true",
    height: "16",
    viewBox: "0 0 16 16",
    width: "16"
  });

  const innerCircle = createSvgNode("circle", {
    cx: "7",
    cy: "8",
    r: "4",
    fill: color
  });

  const outerCircle = createSvgNode("circle", {
    cx: "7",
    cy: "8",
    r: "7",
    stroke: color,
    fill: "transparent"
  });

  svg.append(innerCircle, outerCircle);
  return svg;
}

function createBranchChipIcon(color) {
  const svg = createSvgNode("svg", {
    class: "stc-branch-chip__icon",
    "aria-hidden": "true",
    height: "14",
    viewBox: "0 0 14 14",
    width: "14"
  });

  const path = createSvgNode("path", {
    "fill-rule": "evenodd",
    d: "M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z",
    fill: color
  });

  svg.appendChild(path);
  return svg;
}

function resolveLineSlot(lines, lineIndex) {
  const slot = lines.indexOf(lineIndex);
  return slot === -1 ? lines.length : slot;
}

function drawCurveHorizontal(startX, startY, endX, endY) {
  const firstLineEndX = startX - ((startX - endX - 40) / 2);
  const secondCurveX = firstLineEndX - 40;
  return `M ${startX} ${startY} L ${firstLineEndX} ${startY} C ${firstLineEndX - 20} ${startY}, ${secondCurveX + 20} ${endY}, ${secondCurveX} ${endY} L ${endX} ${endY}`;
}

function drawDottedLineHorizontal(startX, startY) {
  return `M ${startX} ${startY} L ${startX - 10} ${startY} M ${startX - 10} ${startY} L ${startX - 30} ${startY}`;
}

function appendGraphEdge(view, svg, pathData, color, branches, dotted = false) {
  const path = createSvgNode("path", {
    class: "stc-graph-edge stc-graph-path",
    d: pathData,
    stroke: color,
    "data-branches": serializeBranches(branches)
  });

  if (dotted) {
    path.setAttribute("stroke-dasharray", "2 3");
  }

  svg.appendChild(path);
  view.graphEdges.push(path);
}

function serializeBranches(branches) {
  return Array.from(branches || []).filter(Boolean).join("|");
}

function graphElementMatchesBranch(element, branchName) {
  if (!branchName) {
    return true;
  }
  return (element.dataset.branches || "").split("|").includes(branchName);
}

function renderCommitList(view) {
  const commits = getVisibleCommits(view);
  view.commitsContainer.innerHTML = "";
  view.commitElements.clear();

  const templateWrap = document.createElement("div");
  templateWrap.innerHTML = view.itemHtml;
  const template = templateWrap.firstElementChild;

  for (const commit of commits) {
    const node = template.cloneNode(true);
    populateCommitItem(node, view.payload.repo.full_name, commit);
    view.commitsContainer.appendChild(node);
    view.commitElements.set(commit.oid, node);

    node.addEventListener("mouseenter", () => setHoverState(view, null, commit.oid, "list"));
    node.addEventListener("mouseleave", scheduleHoverReset);

    for (const branchChip of node.querySelectorAll("[data-branch-pill]")) {
      attachBranchHover(branchChip, view, branchChip.dataset.branch, commit.oid);
      branchChip.addEventListener("click", () => toggleBranchFilter(view, branchChip.dataset.branch));
    }
  }
}

function populateCommitItem(node, repoFullName, commit) {
  const authorName = commit.author?.login || commit.commit?.author?.name || "unknown";
  const avatar = commit.author?.avatar_url;
  const sha = commit.oid;
  const message = commit.commit?.message?.split("\n")[0] || "";

  node.dataset.sha = sha;
  node.querySelector('[data-slot="commitMessage"]').textContent = message;
  node.querySelector('[data-slot="commitMessage"]').href = `/${repoFullName}/commit/${sha}`;
  node.querySelector('[data-slot="avatarBody"]').setAttribute("aria-label", authorName);
  node.querySelector('[data-slot="hoverCard"]').href = `/${authorName}`;
  node.querySelector('[data-slot="avatarImage"]').alt = `@${authorName}`;
  if (avatar) {
    node.querySelector('[data-slot="avatarImage"]').src = avatar;
  }
  node.querySelector('[data-slot="viewAllCommits"]').textContent = authorName;
  node.querySelector('[data-slot="viewAllCommits"]').href = `/${repoFullName}/commits?author=${encodeURIComponent(authorName)}`;
  node.querySelector('[data-slot="relativeTime"]').textContent = formatRelativeTime(commit.commit?.author?.date || commit.commit?.committer?.date);
  node.querySelector('[data-slot="copyFullSHA"]').setAttribute("value", sha);
  node.querySelector('[data-slot="commitLink"]').href = `/${repoFullName}/commit/${sha}`;
  node.querySelector('[data-slot="commitLink"]').textContent = sha.slice(0, 7);
  node.querySelector('[data-slot="commitTreeLink"]').href = `/${repoFullName}/tree/${sha}`;

  const branchTags = node.querySelector('[data-slot="branchTags"]');
  for (const branchName of commit.branches) {
    const branch = currentView?.branches.find((item) => item.name === branchName);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "stc-branch-chip";
    chip.dataset.branchPill = "true";
    chip.dataset.branch = branchName;
    chip.append(createBranchChipIcon(branch?.color || COLORS[0]), document.createTextNode(branchName));
    branchTags.appendChild(chip);
  }
}

function getVisibleCommits(view) {
  let commits = view.commitsDesc;
  const branchFilter = getEffectiveBranchFilter(view);
  if (branchFilter) {
    commits = commits.filter((commit) => commit.branches.includes(branchFilter));
  }

  if (
    view.hoveredCommit &&
    view.hoveredCommitSource === "graph" &&
    commits.some((commit) => commit.oid === view.hoveredCommit)
  ) {
    const activeCommit = commits.find((commit) => commit.oid === view.hoveredCommit);
    commits = [activeCommit, ...commits.filter((commit) => commit.oid !== view.hoveredCommit)];
  }

  return commits;
}

function setHoverState(view, branchName, commitSha, source = null) {
  if (clearHoverTimer) {
    clearTimeout(clearHoverTimer);
    clearHoverTimer = null;
  }

  if (
    view.hoveredBranch === (branchName || null) &&
    view.hoveredCommit === (commitSha || null) &&
    view.hoveredCommitSource === (source || null)
  ) {
    return;
  }

  const nextHoveredBranch = branchName || null;
  const nextHoveredCommit = commitSha || null;
  const nextSource = source || null;
  const branchFilterBefore = getEffectiveBranchFilter(view);
  const branchFilterAfter = view.activeBranchFilter || nextHoveredBranch;
  const needsListRender = branchFilterBefore !== branchFilterAfter || nextSource === "graph";

  view.hoveredBranch = nextHoveredBranch;
  view.hoveredCommit = nextHoveredCommit;
  view.hoveredCommitSource = nextSource;
  if (needsListRender) {
    renderCommitList(view);
  }
  syncView(view);
}

function scheduleHoverReset() {
  if (clearHoverTimer) {
    clearTimeout(clearHoverTimer);
  }

  clearHoverTimer = window.setTimeout(() => {
    if (!currentView) {
      return;
    }

    const branchFilterBefore = getEffectiveBranchFilter(currentView);
    const branchFilterAfter = currentView.activeBranchFilter || null;
    const needsListRender = branchFilterBefore !== branchFilterAfter || currentView.hoveredCommitSource === "graph";

    currentView.hoveredBranch = null;
    currentView.hoveredCommit = null;
    currentView.hoveredCommitSource = null;
    if (needsListRender) {
      renderCommitList(currentView);
    }
    syncView(currentView);
  }, 48);
}

function toggleBranchFilter(view, branchName) {
  if (clearHoverTimer) {
    clearTimeout(clearHoverTimer);
    clearHoverTimer = null;
  }

  view.activeBranchFilter = view.activeBranchFilter === branchName ? null : branchName;
  renderCommitList(view);
  syncView(view);
}

function getEffectiveBranchFilter(view) {
  return view.activeBranchFilter || view.hoveredBranch;
}

function syncView(view) {
  const visibleShas = new Set(getVisibleCommits(view).map((commit) => commit.oid));
  const branchFilter = getEffectiveBranchFilter(view);

  for (const [branchName, label] of view.branchLabelsMap.entries()) {
    label.classList.toggle("is-active", branchName === branchFilter);
    label.classList.toggle("is-dimmed", Boolean(branchFilter) && branchName !== branchFilter);
  }

  for (const edge of view.graphEdges) {
    const matchesBranch = graphElementMatchesBranch(edge, branchFilter);
    edge.classList.toggle("is-hidden", !matchesBranch);
    edge.classList.toggle("is-dimmed", Boolean(branchFilter) && !matchesBranch);
  }

  for (const [sha, nodes] of view.graphNodes.entries()) {
    for (const node of nodes) {
      const branchMatch = graphElementMatchesBranch(node, branchFilter);
      node.classList.toggle("is-hidden", !branchMatch);
      node.classList.toggle("is-dimmed", Boolean(branchFilter) && !branchMatch);
      node.classList.toggle("is-active", sha === view.hoveredCommit);
    }
  }

  for (const [sha, element] of view.commitElements.entries()) {
    const isVisible = visibleShas.has(sha);
    element.classList.toggle("is-active", sha === view.hoveredCommit);
    element.classList.toggle("is-dimmed", Boolean(view.hoveredCommit) && sha !== view.hoveredCommit);
    element.hidden = !isVisible;

    for (const chip of element.querySelectorAll("[data-branch-pill]")) {
      const chipMatches = !branchFilter || chip.dataset.branch === branchFilter;
      chip.classList.toggle("is-active", chip.dataset.branch === branchFilter);
      chip.classList.toggle("is-dimmed", !chipMatches);
    }
  }

  if (branchFilter) {
    view.listSummary.textContent = `${visibleShas.size} commits in ${branchFilter}`;
    return;
  }

  if (view.hoveredCommit) {
    view.listSummary.textContent =
      view.hoveredCommitSource === "graph"
        ? `${visibleShas.size} commits • ${view.hoveredCommit.slice(0, 7)} pinned first`
        : `${visibleShas.size} commits • ${view.hoveredCommit.slice(0, 7)} highlighted`;
    return;
  }

  view.listSummary.textContent = `${view.commitsAsc.length} commits loaded`;
}

function attachBranchHover(element, view, branchName, commitSha = null) {
  element.addEventListener("mouseenter", () => setHoverState(view, branchName, commitSha));
  element.addEventListener("mouseleave", scheduleHoverReset);
}

function createSvgNode(tagName, attributes) {
  const node = document.createElementNS(SVG_NS, tagName);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value);
  }
  return node;
}

function dedupeValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getContentView() {
  return (
    document.getElementsByClassName("clearfix")[0] ||
    document.querySelector('[data-testid="repository-container"]') ||
    document.querySelector("main")
  );
}

function hideExistingContent(container) {
  [...container.children].forEach((child) => {
    if (child.id === PANEL_ID) return;
    child.dataset.stcHidden = "true";
    child.style.display = "none";
  });
}

function restoreExistingContent(container) {
  [...container.children].forEach((child) => {
    if (child.dataset.stcHidden === "true") {
      child.style.display = "";
      delete child.dataset.stcHidden;
    }
  });
}

function ensurePanel(container) {
  let root = document.getElementById(PANEL_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = PANEL_ID;
    container.appendChild(root);
  }
  return root;
}

function cleanupPanel() {
  if (clearHoverTimer) {
    clearTimeout(clearHoverTimer);
    clearHoverTimer = null;
  }

  const container = getContentView();
  if (container) restoreExistingContent(container);
  document.getElementById(PANEL_ID)?.remove();
  currentView = null;
}

function getRepoInfo() {
  const match = window.location.pathname.match(REPO_PATTERN);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo || owner === "settings" || repo === "settings") return null;
  return { owner, repo: repo.replace(/\.git$/, "") };
}

function getCurrentBranchName() {
  const branchButton = document.querySelector('[data-hotkey="w"] span');
  return branchButton?.textContent?.trim() || "";
}

function observeLocationChanges(onChange) {
  let href = window.location.href;
  const observer = new MutationObserver(() => {
    if (href !== window.location.href) {
      href = window.location.href;
      isCommitsTabOpen = false;
      onChange();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function formatRelativeTime(isoDate) {
  if (!isoDate) return "recently";
  const date = new Date(isoDate);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];

  for (const [unit, size] of units) {
    if (seconds >= size) {
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-Math.floor(seconds / size), unit);
    }
  }

  return "just now";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || "Request failed"));
      resolve(response);
    });
  });
}
