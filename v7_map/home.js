"use strict";
// Preserve demo and compound links from the first static release.
const entryParams = new URLSearchParams(location.search);
if (entryParams.has("demo")) location.replace("identification.html?mode=guided&cid=2519");
else if (entryParams.has("cid")) location.replace("architecture.html" + location.search);
