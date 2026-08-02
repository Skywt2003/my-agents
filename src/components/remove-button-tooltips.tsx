"use client";

import { useEffect } from "react";

function removeButtonTooltip(button: HTMLButtonElement) {
  const title = button.getAttribute("title")?.trim();

  if (title && !button.hasAttribute("aria-label") && !button.hasAttribute("aria-labelledby")) {
    button.setAttribute("aria-label", title);
  }

  button.removeAttribute("title");
}

function removeButtonTooltips(root: ParentNode) {
  if (root instanceof HTMLButtonElement && root.hasAttribute("title")) {
    removeButtonTooltip(root);
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>("button[title]")) {
    removeButtonTooltip(button);
  }
}

export function RemoveButtonTooltips() {
  useEffect(() => {
    removeButtonTooltips(document);

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          removeButtonTooltips(record.target as HTMLButtonElement);
          continue;
        }

        for (const node of record.addedNodes) {
          if (node instanceof Element) {
            removeButtonTooltips(node);
          }
        }
      }
    });

    observer.observe(document.body, {
      attributeFilter: ["title"],
      attributes: true,
      childList: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, []);

  return null;
}
