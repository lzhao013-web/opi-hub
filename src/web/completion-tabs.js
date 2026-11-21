const focusWait = 400;

function requestFocus(deadline) {
  const remaining = deadline - Date.now();
  if (!(remaining > 0 && remaining <= focusWait)) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = (focused) => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      resolve(focused);
    };
    const check = () => { if (document.hasFocus() && !document.hidden) finish(true); };
    const timer = setTimeout(() => finish(false), remaining);
    window.addEventListener("focus", check);
    window.focus();
    check();
  });
}

// 先询问谁能处理目标，再只让一个标签页尝试切到前台。
export function completionTabs(matches, show = () => {}) {
  const channel = new BroadcastChannel("opi-hub.completion-tabs");
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  let sequence = 0;
  channel.addEventListener("message", async ({ data }) => {
    if (!data?.request || !data.target || !matches(data.target)) return;
    if (data.type === "probe") {
      channel.postMessage({ type: "offer", request: data.request, tab: id });
    } else if (data.type === "focus" && data.tab === id) {
      if (!await requestFocus(data.deadline) || Date.now() >= data.deadline || !matches(data.target) || !document.hasFocus()) return;
      show(data.target);
      channel.postMessage({ type: "opened", request: data.request, tab: id });
    }
  });
  window.addEventListener("pagehide", event => { if (!event.persisted) channel.close(); });

  return {
    reuse(target, current) {
      const request = `${id}:${++sequence}`;
      return new Promise(resolve => {
        let tab;
        const finish = (opened) => {
          clearTimeout(timer);
          channel.removeEventListener("message", receive);
          resolve(opened);
        };
        const receive = ({ data }) => {
          if (data?.request !== request) return;
          if (!tab && data.type === "offer" && typeof data.tab === "string" && data.tab) {
            if (!current()) return finish(false);
            tab = data.tab;
            const deadline = Date.now() + focusWait;
            clearTimeout(timer);
            timer = setTimeout(() => finish(false), focusWait + 100);
            channel.postMessage({ type: "focus", request, tab, target, deadline });
          } else if (tab && data.type === "opened" && data.tab === tab) finish(true);
        };
        let timer = setTimeout(() => finish(false), 200);
        channel.addEventListener("message", receive);
        channel.postMessage({ type: "probe", request, target });
      });
    },
  };
}
