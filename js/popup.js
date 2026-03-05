// ===== Helpers (FQDN etc.) =====
function getFQDN(urlString, tabTitle) {
  if (!urlString) return tabTitle || "No URL Tab";
  try {
    if (
      urlString.startsWith("chrome://") ||
      urlString.startsWith("about:") ||
      urlString.startsWith("chrome-extension://") ||
      urlString.startsWith("edge://") ||
      urlString.startsWith("moz-extension://")
    ) {
      const schemeEnd = urlString.indexOf("://");
      if (schemeEnd > -1) {
        const pathStart = urlString.indexOf("/", schemeEnd + 3);
        if (pathStart > -1 && pathStart > schemeEnd + 3) {
          return urlString.substring(schemeEnd + 3, pathStart);
        }
        const pseudoHost = urlString.substring(schemeEnd + 3);
        return pseudoHost || tabTitle || "Special Page";
      }
      return tabTitle || "Special Page";
    }
    const urlObj = new URL(urlString);
    if (urlObj.hostname) return urlObj.hostname;
    if (urlObj.protocol === "file:") return "Local Files";
    return tabTitle || "Unidentified Host";
  } catch (e) {
    return tabTitle || "Other/Invalid URL";
  }
}

// Colors for group titles (unchanged)
const groupColors = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan"];
let colorIndex = 0;
function pickAColor() {
  const color = groupColors[colorIndex % groupColors.length];
  colorIndex++;
  return color;
}

// ===== UI sugar (toast, busy, options) =====
const Toast = (() => {
  let el;
  function ensure() { el = el || document.getElementById("toast"); return el; }
  return {
    show(msg, ms = 1500) {
      const t = ensure();
      if (!t) return;
      t.textContent = msg;
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), ms);
    }
  };
})();
const Busy = (() => {
  let el;
  function ensure(){ el = el || document.getElementById("busy"); return el; }
  return {
    on(){ const e = ensure(); if (e) e.classList.add("show"); },
    off(){ const e = ensure(); if (e) e.classList.remove("show"); },
    async wrap(fn){ try{ Busy.on(); return await fn(); } finally { Busy.off(); } }
  };
})();

const Options = {
  async load() {
    const res = await chrome.storage.sync.get(["autoClose", "confirmMerge"]);
    const autoClose = !!res.autoClose;
    const confirmMerge = !!res.confirmMerge;
    document.getElementById("toggleAutoClose").checked = autoClose;
    document.getElementById("toggleConfirm").checked = confirmMerge;
  },
  async save() {
    const autoClose = document.getElementById("toggleAutoClose").checked;
    const confirmMerge = document.getElementById("toggleConfirm").checked;
    await chrome.storage.sync.set({ autoClose, confirmMerge });
  },
  get autoClose(){ return document.getElementById("toggleAutoClose").checked; },
  get confirmMerge(){ return document.getElementById("toggleConfirm").checked; }
};

// ===== Core sorting/moving helpers (unchanged logic) =====
async function handleSortOperation(sortTypeDescription, sortFunction) {
  console.log(`--- Starting Sort Operation: ${sortTypeDescription} ---`);
  let allTabsInWindow = await new Promise((resolve) =>
    chrome.tabs.query({ currentWindow: true, windowType: "normal" }, resolve)
  );

  if (allTabsInWindow.length === 0) {
    console.log("No tabs to sort.");
    Toast.show("No tabs to sort");
    return;
  }

  const currentWindowId = allTabsInWindow[0].windowId;
  const pinnedTabs = allTabsInWindow.filter((t) => t.pinned);
  const unpinnedTabs = allTabsInWindow.filter((t) => !t.pinned);

  const groupedTabsByGroupId = new Map();
  const ungroupedNonPinnedTabs = [];

  const NO_GROUP_ID_CONSTANT =
    typeof chrome.tabGroups !== "undefined" && chrome.tabGroups.TAB_GROUP_ID_NONE !== undefined
      ? chrome.tabGroups.TAB_GROUP_ID_NONE
      : -1;

  unpinnedTabs.forEach((tab) => {
    if (tab.groupId && tab.groupId !== NO_GROUP_ID_CONSTANT && tab.groupId !== -1) {
      if (!groupedTabsByGroupId.has(tab.groupId)) groupedTabsByGroupId.set(tab.groupId, []);
      groupedTabsByGroupId.get(tab.groupId).push(tab);
    } else {
      ungroupedNonPinnedTabs.push(tab);
    }
  });

  let actualTabGroups = [];
  if (typeof chrome.tabGroups !== "undefined" && typeof chrome.tabGroups.query === "function") {
    try {
      actualTabGroups = await new Promise((resolve) =>
        chrome.tabGroups.query({ windowId: currentWindowId }, resolve)
      );
      actualTabGroups.sort((groupA, groupB) => {
        const findMinIndex = (groupId) => {
          let minIdx = Infinity;
          let found = false;
          for (const tab of allTabsInWindow) {
            if (tab.groupId === groupId) { minIdx = Math.min(minIdx, tab.index); found = true; }
          }
          return found ? minIdx : Infinity;
        };
        return findMinIndex(groupA.id) - findMinIndex(groupB.id);
      });
    } catch (e) {
      console.warn("Error querying/sorting tab groups:", e);
      actualTabGroups = [];
    }
  } else {
    console.warn("tabGroups API not available; sorting ungrouped only.");
    groupedTabsByGroupId.clear();
  }

  for (const group of actualTabGroups) {
    const tabsInThisGroup = groupedTabsByGroupId.get(group.id);
    if (tabsInThisGroup && tabsInThisGroup.length > 0) {
      sortFunction(tabsInThisGroup);
      groupedTabsByGroupId.set(group.id, tabsInThisGroup);
    }
  }
  if (ungroupedNonPinnedTabs.length > 0) sortFunction(ungroupedNonPinnedTabs);

  const finalSortedTabIds = [];
  pinnedTabs.forEach((tab) => finalSortedTabIds.push(tab.id));
  if (actualTabGroups.length > 0) {
    for (const group of actualTabGroups) {
      const sortedTabsInThisGroup = groupedTabsByGroupId.get(group.id);
      if (sortedTabsInThisGroup) sortedTabsInThisGroup.forEach((tab) => finalSortedTabIds.push(tab.id));
    }
  }
  ungroupedNonPinnedTabs.forEach((tab) => { if (!finalSortedTabIds.includes(tab.id)) finalSortedTabIds.push(tab.id); });

  const uniqueFinalSortedTabIds = [...new Set(finalSortedTabIds)];

  for (let i = 0; i < uniqueFinalSortedTabIds.length; i++) {
    const tabIdToMove = uniqueFinalSortedTabIds[i];
    const desiredFinalIndex = i;

    let currentTabDetails;
    try {
      currentTabDetails = await new Promise((resolve, reject) => {
        chrome.tabs.get(tabIdToMove, (tabDetails) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(tabDetails);
        });
      });
    } catch (e) {
      console.warn(`Could not get tab ${tabIdToMove}:`, e.message);
      continue;
    }

    if (currentTabDetails.index !== desiredFinalIndex) {
      try {
        await new Promise((resolve) => {
          chrome.tabs.move(tabIdToMove, { index: desiredFinalIndex }, () => resolve());
        });
      } catch (error) {
        console.error(`Error moving tab ${tabIdToMove}:`, error);
      }
    }
  }
  Toast.show(`${sortTypeDescription} sorted`);
  if (Options.autoClose) window.close();
}

function sortByProperty(tabs, reverse, state, propertyExtractor) {
  tabs.sort(function (a, b) {
    let valAFromExtractor = propertyExtractor(a);
    let valBFromExtractor = propertyExtractor(b);
    var valA = String(
      state && state[a.id] !== undefined ? state[a.id] : valAFromExtractor !== undefined ? valAFromExtractor : ""
    ).toLowerCase();
    var valB = String(
      state && state[b.id] !== undefined ? state[b.id] : valBFromExtractor !== undefined ? valBFromExtractor : ""
    ).toLowerCase();
    if (valA < valB) return reverse * 1;
    if (valA > valB) return reverse * -1;
    return 0;
  });
}

function sortTabsStableByFQDN(tabs, fqdnMap, originalIndexMap, reverse = -1) {
  tabs.sort(function (a, b) {
    const fqdnA = String(fqdnMap[a.id] || "").toLowerCase();
    const fqdnB = String(fqdnMap[b.id] || "").toLowerCase();
    if (fqdnA < fqdnB) return reverse * 1;
    if (fqdnA > fqdnB) return reverse * -1;
    return (originalIndexMap[a.id] || 0) - (originalIndexMap[b.id] || 0);
  });
}

// ===== Stats =====
async function refreshStats() {
  const [tabs, windows] = await Promise.all([
    chrome.tabs.query({ windowType: "normal" }),
    chrome.windows.getAll({ windowTypes: ["normal"] })
  ]);

  const currentWindow = await new Promise((resolve) =>
    chrome.windows.getCurrent({ populate: true }, resolve)
  );

  let groupCount = 0;
  try {
    const groups = await chrome.tabGroups.query({ windowId: currentWindow.id });
    groupCount = groups?.length || 0;
  } catch { /* tabGroups may not be available on older Chromium */ }

  const domainMap = new Map();
  tabs.forEach((tab) => {
    const label = getFQDN(tab.url, tab.title);
    const key = label.toLowerCase();
    if (!domainMap.has(key)) {
      domainMap.set(key, {
        key,
        label,
        total: 0,
        pinnedCount: 0,
        activeUnpinnedCount: 0,
        closableIds: []
      });
    }
    const entry = domainMap.get(key);
    const isPinned = !!tab.pinned;
    const isActive = !!tab.active;
    entry.total += 1;
    if (isPinned) {
      entry.pinnedCount += 1;
    }
    if (!isPinned && isActive) {
      entry.activeUnpinnedCount += 1;
    }
    if (!isPinned && !isActive) {
      entry.closableIds.push(tab.id);
    }
  });

  const domainEntries = Array.from(domainMap.values()).sort((a, b) => {
    if (b.total !== a.total) {
      return b.total - a.total;
    }
    return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
  });

  document.getElementById("statTabs").textContent = String(tabs.length);
  document.getElementById("statWindows").textContent = String(windows.length);
  document.getElementById("statGroups").textContent = String(groupCount);
  document.getElementById("statDomains").textContent = String(domainEntries.length);

  const domainListEl = document.getElementById("domainList");
  const domainHintEl = document.getElementById("domainHint");
  const domainEmptyEl = document.getElementById("domainEmpty");

  if (domainListEl && domainHintEl && domainEmptyEl) {
    domainListEl.innerHTML = "";
    const fragment = document.createDocumentFragment();
    let closableDomainCount = 0;

    domainEntries.forEach((entry) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "domain-item" + (entry.closableIds.length ? "" : " is-empty");
      button.setAttribute("role", "listitem");

      const nameSpan = document.createElement("span");
      nameSpan.className = "domain-item__name";
      nameSpan.textContent = entry.label;

      const countSpan = document.createElement("span");
      countSpan.className = "domain-item__count";
      const countLabel = `${entry.total} tab${entry.total === 1 ? "" : "s"}`;
      const pinnedLabel = entry.pinnedCount ? ` • ${entry.pinnedCount} pinned` : "";
      const activeLabel = entry.activeUnpinnedCount ? ` • ${entry.activeUnpinnedCount} active` : "";
      countSpan.textContent = countLabel + pinnedLabel + activeLabel;

      button.appendChild(nameSpan);
      button.appendChild(countSpan);

      if (entry.closableIds.length) {
        closableDomainCount += 1;
        button.title = `Close ${entry.closableIds.length} unpinned tab${entry.closableIds.length === 1 ? "" : "s"} from ${entry.label}`;
        button.addEventListener("click", () => {
          if (!entry.closableIds.length) {
            if (entry.activeUnpinnedCount) {
              Toast.show("Active tab kept open; switch tabs and try again");
            } else {
              Toast.show("All tabs for this domain are pinned");
            }
            return;
          }
          return Busy.wrap(() => closeTabsForDomain(entry));
        });
      } else {
        if (entry.activeUnpinnedCount) {
          const suffix = entry.activeUnpinnedCount === 1 ? "tab" : "tabs";
          button.title = `${entry.activeUnpinnedCount} active ${suffix} kept open`;
        } else {
          button.title = "All tabs for this domain are pinned";
        }
      }

      fragment.appendChild(button);
    });

    domainListEl.appendChild(fragment);
    const hasDomains = domainEntries.length > 0;
    domainListEl.hidden = !hasDomains;
    domainEmptyEl.hidden = hasDomains;
    domainHintEl.hidden = closableDomainCount === 0;
  }
}

async function closeTabsForDomain(entry) {
  const tabIds = Array.isArray(entry?.closableIds) ? entry.closableIds.slice() : [];
  if (!tabIds.length) {
    Toast.show("No unpinned tabs to close");
    return;
  }

  const removeTabs = (ids) => new Promise((resolve, reject) => {
    try {
      chrome.tabs.remove(ids, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
        } else {
          resolve();
        }
      });
    } catch (error) {
      reject(error);
    }
  });

  try {
    await removeTabs(tabIds);
    const count = tabIds.length;
    Toast.show(`Closed ${count} tab${count === 1 ? "" : "s"} from ${entry.label}`);
  } catch (error) {
    console.error(`Error closing tabs for ${entry?.label}:`, error);
    Toast.show(`Couldn't close tabs for ${entry?.label || "this domain"}`);
  }

  if (Options.autoClose) {
    window.close();
  } else {
    await refreshStats();
  }
}

// ===== Wire up UI =====
document.addEventListener("DOMContentLoaded", async function () {
  await Options.load();
  await refreshStats();

  const buttonT = document.getElementById("buttonT");
  const buttonFQDN = document.getElementById("buttonFQDN");
  const buttonGroupFQDN = document.getElementById("buttonGroupFQDN");
  const buttonMergeWindows = document.getElementById("buttonMergeWindows");

  // Sort by Title
  buttonT.addEventListener("click", () =>
    Busy.wrap(() =>
      handleSortOperation("Title", function (tabsToSort) {
        const titleMap = {};
        tabsToSort.forEach((tab) => { titleMap[tab.id] = tab.title; });
        sortByProperty(tabsToSort, -1, titleMap, (tab) => tab.title);
      })
    )
  );

  // Sort by FQDN
  buttonFQDN.addEventListener("click", () =>
    Busy.wrap(() =>
      handleSortOperation("FQDN", function (tabsToSort) {
        const fqdnMap = {};
        const originalIndexMap = {};
        tabsToSort.forEach((tab, index) => {
          fqdnMap[tab.id] = getFQDN(tab.url, tab.title);
          const originalIndex = typeof tab.index === "number" ? tab.index : index;
          originalIndexMap[tab.id] = originalIndex;
        });
        sortTabsStableByFQDN(tabsToSort, fqdnMap, originalIndexMap);
      })
    )
  );

  // Group by FQDN (with toast)
  const MIN_TABS_FOR_GROUP = 2;
  buttonGroupFQDN.addEventListener("click", async function () {
    await Busy.wrap(async () => {
      if (typeof chrome.tabGroups === "undefined" || typeof chrome.tabGroups.query !== "function") {
        Toast.show("Tab Groups API not available");
        return;
      }
      let tabsInCurrentWindow = await new Promise((resolve) =>
        chrome.tabs.query({ currentWindow: true, windowType: "normal" }, resolve)
      );
      if (tabsInCurrentWindow.length < MIN_TABS_FOR_GROUP) {
        Toast.show("Not enough tabs to group");
        return;
      }
      const currentWindowId = tabsInCurrentWindow[0].windowId;
      const tabIdsToUngroup = tabsInCurrentWindow.filter((t) => !t.pinned).map((tab) => tab.id);
      if (tabIdsToUngroup.length > 0) {
        try { await chrome.tabs.ungroup(tabIdsToUngroup); }
        catch (error) {
          const msg = String(error?.message || "");
          if (!msg.includes("NO_GROUP_PRESENT") && !msg.includes("TABS_NOT_IN_GROUP")) console.error("Ungroup:", error);
        }
      }

      tabsInCurrentWindow = await new Promise((resolve) =>
        chrome.tabs.query({ windowId: currentWindowId, windowType: "normal" }, resolve)
      );
      const fqdnTabMap = new Map();
      tabsInCurrentWindow.forEach((tab) => {
        if (tab.pinned) return;
        const fqdn = getFQDN(tab.url, tab.title).toLowerCase();
        if (!fqdnTabMap.has(fqdn)) fqdnTabMap.set(fqdn, []);
        fqdnTabMap.get(fqdn).push(tab.id);
      });
      colorIndex = 0;
      const sortedFqdns = Array.from(fqdnTabMap.keys()).sort();
      for (const fqdn of sortedFqdns) {
        const tabIdsForFqdn = fqdnTabMap.get(fqdn);
        if (tabIdsForFqdn.length >= MIN_TABS_FOR_GROUP) {
          try {
            const newGroupId = await chrome.tabs.group({ tabIds: tabIdsForFqdn, createProperties: { windowId: currentWindowId } });
            await chrome.tabGroups.update(newGroupId, { title: fqdn, color: pickAColor() });
          } catch (error) { console.error(`Group for ${fqdn}:`, error); }
        }
      }
      Toast.show("Grouped by FQDN");
      await refreshStats();
      if (Options.autoClose) window.close();
    });
  });

  // Merge all windows (confirm optional)
  buttonMergeWindows.addEventListener("click", function () {
    Busy.wrap(async () => {
      if (Options.confirmMerge) {
        const ok = confirm("Merge all windows into the current one?");
        if (!ok) return;
      }
      chrome.windows.getCurrent(async function (currentWindow) {
        if (!currentWindow) { console.error("Could not get current window."); return; }
        let windows = await new Promise((resolve) =>
          chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }, resolve)
        );
        let tabsToMoveIds = [];
        windows.forEach(function (win) {
          if (win.id !== currentWindow.id && win.tabs) {
            win.tabs.forEach(function (tab) { tabsToMoveIds.push(tab.id); });
          }
        });
        if (tabsToMoveIds.length > 0) {
          chrome.tabs.move(tabsToMoveIds, { windowId: currentWindow.id, index: -1 }, function () {
            if (chrome.runtime.lastError) {
              Toast.show("Error merging tabs");
            } else {
              chrome.windows.update(currentWindow.id, { focused: true });
              Toast.show(`${tabsToMoveIds.length} tab(s) merged`);
            }
          });
        } else {
          Toast.show("No other windows to merge");
        }
        await refreshStats();
        if (Options.autoClose) window.close();
      });
    });
  });

  // Options
  document.getElementById("toggleAutoClose").addEventListener("change", () => Options.save());
  document.getElementById("toggleConfirm").addEventListener("change", () => Options.save());

  // Domain list resize handle
  const domainListEl2 = document.getElementById("domainList");
  const resizeHandle = document.getElementById("domainResizeHandle");
  const MIN_LIST_HEIGHT = 80;
  // Measure fixed content height NOW, before restoring any saved preference,
  // so the baseline is accurate regardless of what was saved.
  const fixedOtherHeight = document.documentElement.scrollHeight - domainListEl2.getBoundingClientRect().height;
  // ~90px accounts for browser chrome (tab bar + address bar) above the popup
  const safeMax = Math.max(MIN_LIST_HEIGHT, window.screen.availHeight - fixedOtherHeight - 90);

  const { domainListHeight } = await chrome.storage.local.get("domainListHeight");
  if (domainListHeight) domainListEl2.style.maxHeight = Math.min(domainListHeight, safeMax) + "px";

  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    resizeHandle.classList.add("is-dragging");
    const startY = e.clientY;
    const startHeight = domainListEl2.getBoundingClientRect().height;

    function onMouseMove(ev) {
      const newHeight = Math.min(safeMax, Math.max(MIN_LIST_HEIGHT, startHeight + ev.clientY - startY));
      domainListEl2.style.maxHeight = newHeight + "px";
    }

    function onMouseUp() {
      resizeHandle.classList.remove("is-dragging");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      chrome.storage.local.set({ domainListHeight: parseFloat(domainListEl2.style.maxHeight) });
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "t") return buttonT.click();
    if (k === "f") return buttonFQDN.click();
    if (k === "g") return buttonGroupFQDN.click();
    if (k === "m") return buttonMergeWindows.click();
  });

  // Keep stats roughly fresh while popup is open
  setTimeout(refreshStats, 400);
  setTimeout(refreshStats, 1200);
});
