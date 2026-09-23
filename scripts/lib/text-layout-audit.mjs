// Browser-side geometry check shared by synthetic UI canaries. Return only
// fixed selector names/reasons, never label contents or session identifiers.
export function auditTextLayout({ selectors, groups = [], complete = [] }) {
  const issues = [];
  const visible = e => e.checkVisibility({ checkVisibilityCSS: true }) && e.getBoundingClientRect().width > 0;
  for (const selector of selectors) {
    for (const e of document.querySelectorAll(selector)) {
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect(), style = getComputedStyle(e);
      // A deliberate tab/presence scroller may contain offscreen siblings.
      // Its reachability is checked separately; the label still needs bounds.
      const scrolling = ['auto','scroll'].includes(getComputedStyle(e.parentElement).overflowX);
      if (!scrolling && (r.left < p.left - 2 || r.right > p.right + 2)) issues.push(selector + ': outside its container');
      const overflowing = e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 2;
      if (overflowing && style.overflowX === 'visible') issues.push(selector + ': text overflows');
      if (overflowing && complete.includes(selector)) issues.push(selector + ': required badge text clipped');
      if (overflowing && style.overflowX === 'hidden' && style.textOverflow !== 'ellipsis' && style.webkitLineClamp === 'none') issues.push(selector + ': clipped without ellipsis');
    }
  }
  for (const selector of groups) {
    for (const group of document.querySelectorAll(selector)) {
      const children = [...group.children].filter(visible).map(e => e.getBoundingClientRect());
      for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
        const a = children[i], b = children[j];
        if (Math.min(a.right,b.right)-Math.max(a.left,b.left)>2 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2) issues.push(selector + ': labels overlap');
      }
    }
  }
  return [...new Set(issues)];
}
