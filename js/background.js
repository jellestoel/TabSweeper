// --- Context Menu Setup ---
function getFQDNFromUrl(urlString) {
  if (!urlString) return null;
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
        return pseudoHost || "Special Page";
      }
      return "Special Page";
    }
    const urlObj = new URL(urlString);
    if (urlObj.hostname) return urlObj.hostname;
    if (urlObj.protocol === "file:") return "Local Files";
    return null;
  } catch (e) {
    return null;
  }
}

const groupColorsBg = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan"];
let colorIndexBg = 0;
function pickAColorBg() {
  const color = groupColorsBg[colorIndexBg % groupColorsBg.length];
  colorIndexBg++;
  return color;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("onInstalled: creating context menus");
  chrome.contextMenus.create(
    {
      id: "groupTabsByDomain",
      title: "Group Tabs from this Domain",
      contexts: ["page"]
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error("Error creating 'groupTabsByDomain':", chrome.runtime.lastError.message);
      }
    }
  );

  chrome.contextMenus.create(
    {
      id: "closeTabsByDomain",
      title: "Close All Tabs from this Domain",
      contexts: ["page"]
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error("Error creating 'closeTabsByDomain':", chrome.runtime.lastError.message);
      }
    }
  );
});

// Context menu handler
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  console.log("Context menu clicked:", info.menuItemId, "on tab:", tab);

  if (!tab || !tab.url) {
    console.warn("Context menu clicked on a tab/page with no URL.");
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon/icon.png",
      title: "TabSorter Action",
      message: "Action requires a page with a valid URL."
    });
    return;
  }

  const domain = getFQDNFromUrl(tab.url);
  if (!domain) {
    console.warn("Could not determine domain for the page:", tab.url);
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon/icon.png",
      title: "TabSorter Action",
      message: "Could not determine the domain for the selected page."
    });
    return;
  }

  if (info.menuItemId === "groupTabsByDomain") {
    colorIndexBg = 0;
    const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
    const tabsToGroupIds = tabsInWindow
      .filter((t) => !t.pinned && getFQDNFromUrl(t.url) === domain)
      .map((t) => t.id);

    if (tabsToGroupIds.length === 0) {
      console.log(`No other unpinned tabs for domain: ${domain} in this window.`);
      return;
    }

    try {
      try {
        await chrome.tabs.ungroup(tabsToGroupIds);
      } catch (ungroupError) {
        const msg = (ungroupError && ungroupError.message ? ungroupError.message : "").toLowerCase();
        if (!msg.includes("no group present") && !msg.includes("tabs are not in any group")) {
          console.warn("Minor error during pre-ungrouping:", ungroupError);
        }
      }

      const newGroupId = await chrome.tabs.group({
        tabIds: tabsToGroupIds,
        createProperties: { windowId: tab.windowId }
      });
      await chrome.tabGroups.update(newGroupId, {
        title: domain,
        color: pickAColorBg()
      });
      console.log(`Grouped ${tabsToGroupIds.length} tabs for domain: ${domain}`);
    } catch (error) {
      console.error(`Error grouping tabs for ${domain}:`, error);
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icon/icon.png",
        title: "TabSorter Error",
        message: `Could not group tabs for ${domain}. See console.`
      });
    }
  } else if (info.menuItemId === "closeTabsByDomain") {
    const tabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
    const tabsToCloseIds = tabsInWindow
      .filter((t) => !t.pinned && getFQDNFromUrl(t.url) === domain)
      .map((t) => t.id);

    if (tabsToCloseIds.length === 0) {
      console.log(`No unpinned tabs found for domain: ${domain} to close.`);
      return;
    }

    try {
      await chrome.tabs.remove(tabsToCloseIds);
      console.log(`Closed ${tabsToCloseIds.length} tabs for domain: ${domain}`);
    } catch (e) {
      console.error("Error closing tabs:", e);
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icon/icon.png",
        title: "TabSorter Error",
        message: `Could not close tabs for ${domain}. See console.`
      });
    }
  }
});
