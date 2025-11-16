(function () {
  const pluginId = "bf-portal-copy-paste-plugin";
  const plugin = BF2042Portal.Plugins.getPlugin(pluginId);

  let lastMouseEvent = null;

  function attachMouseTracking(ws) {
    try {
      const svg = ws.getParentSvg();
      if (!svg || svg._copyPasteTrackingAttached) return;
      svg._copyPasteTrackingAttached = true;
      svg.addEventListener(
        "mousemove",
        (e) => {
          lastMouseEvent = e;
        },
        { passive: true }
      );
    } catch (e) {
      console.warn("[CopyPastePlugin] attachMouseTracking failed:", e);
    }
  }

  function getMouseWorkspacePosition(ws) {
    try {
      if (!lastMouseEvent) {
        const metrics = ws.getMetrics();
        return {
          x: (metrics.viewLeft || 0) + (metrics.viewWidth || 0) / 2,
          y: (metrics.viewTop || 0) + (metrics.viewHeight || 0) / 2,
        };
      }

      let canvas = null;
      try {
        if (typeof ws.getCanvas === "function") canvas = ws.getCanvas();
      } catch {}
      if (!canvas) canvas = document.querySelector(".blocklyBlockCanvas");

      if (
        canvas &&
        canvas.ownerSVGElement &&
        typeof canvas.getScreenCTM === "function"
      ) {
        const svg = canvas.ownerSVGElement;
        const pt = svg.createSVGPoint();
        pt.x = lastMouseEvent.clientX;
        pt.y = lastMouseEvent.clientY;

        const ctm = canvas.getScreenCTM();
        if (ctm && typeof ctm.inverse === "function") {
          const inv = ctm.inverse();
          const transformed = pt.matrixTransform(inv);
          return { x: transformed.x, y: transformed.y };
        }
      }

      const svg = ws.getParentSvg();
      const rect = svg.getBoundingClientRect();
      const relativeX = lastMouseEvent.clientX - rect.left;
      const relativeY = lastMouseEvent.clientY - rect.top;
      const metrics = ws.getMetrics();
      const scale = ws.scale || 1;
      const scrollX =
        metrics.viewLeft !== undefined ? metrics.viewLeft : ws.scrollX || 0;
      const scrollY =
        metrics.viewTop !== undefined ? metrics.viewTop : ws.scrollY || 0;

      return {
        x: scrollX + relativeX / scale,
        y: scrollY + relativeY / scale,
      };
    } catch {
      const metrics = ws.getMetrics();
      return {
        x: (metrics.viewLeft || 0) + (metrics.viewWidth || 0) / 2,
        y: (metrics.viewTop || 0) + (metrics.viewHeight || 0) / 2,
      };
    }
  }

  function ensureVariableExists(ws, name, type) {
    try {
      const varMap = ws.getVariableMap();
      if (!varMap) return null;

      let existing = null;

      try {
        existing = varMap.getVariable(name);
      } catch {}

      try {
        if (!existing && typeof varMap.getVariableByName === "function") {
          existing = varMap.getVariableByName(name);
        }
      } catch {}

      if (!existing) {
        if (typeof varMap.createVariable === "function") {
          return varMap.createVariable(name, type || "", undefined);
        }
        if (typeof ws.createVariable === "function") {
          return ws.createVariable(name, type || "", undefined);
        }
      }
      return existing;
    } catch {
      return null;
    }
  }

  function traverseSerializedBlocks(node, cb) {
    if (!node) return;
    cb(node);

    if (node.inputs && typeof node.inputs === "object") {
      for (const input of Object.values(node.inputs)) {
        if (input && input.block)
          traverseSerializedBlocks(input.block, cb);
        if (input && input.shadow)
          traverseSerializedBlocks(input.shadow, cb);
      }
    }

    if (node.next && node.next.block)
      traverseSerializedBlocks(node.next.block, cb);
  }

  /* ------------------------------------------------------
     FIXED SANITIZER
     - Skips variableReferenceBlock entirely
     - Skips subroutineArgumentBlock entirely
     - Prevents destruction of OBJECT / TEAM / PLAYER inputs
  ------------------------------------------------------- */
  function sanitizeForWorkspace(ws, root) {
    traverseSerializedBlocks(root, (b) => {

      // 🛑 FIX #1 — Never modify variableReferenceBlock (keeps OBJECT input intact)
      if (b.type === "variableReferenceBlock") return;

      // 🛑 FIX #2 — Never modify subroutineArgumentBlock
      if (b.type === "subroutineArgumentBlock") return;

      // ✔ Normal sanitization below (safe for all other blocks)

      if (b.fields) {
        for (const [key, val] of Object.entries(b.fields)) {
          const ku = key.toUpperCase();
          if (ku === "VAR" || ku === "VARIABLE" || ku.startsWith("VAR")) {
            let varName = val;
            if (val && typeof val === "object" && val.name)
              varName = val.name;

            if (typeof varName === "string" && varName.length > 0) {
              ensureVariableExists(ws, varName, val?.type || "");
            }
          }
        }
      }

      // Dropdown sanitization (unchanged)
      if (b.fields) {
        for (const [key, val] of Object.entries(b.fields)) {
          if (typeof val !== "string") continue;
          try {
            const temp = ws.newBlock(b.type);
            const field = temp.getField(key);
            if (field && typeof field.getOptions === "function") {
              const opts = field.getOptions();
              const values = opts.map((o) => o[1]);
              if (!values.includes(val)) b.fields[key] = values[0] || "";
            }
            temp.dispose(false);
          } catch {}
        }
      }
    });

    return root;
  }

  function extractBlockForClipboard(block) {
    try {
      const full = _Blockly.serialization.blocks.save(block);
      if (full.next) delete full.next;
      return full;
    } catch {
      try {
        const xml = Blockly.Xml.blockToDom(block, true);
        return { _legacyXml: Blockly.Xml.domToText(xml) };
      } catch {
        return null;
      }
    }
  }

  async function copyBlockToClipboard(block) {
    try {
      const minimal = extractBlockForClipboard(block);
      if (!minimal) return;
      await navigator.clipboard.writeText(
        JSON.stringify(minimal, null, 2)
      );
    } catch {}
  }

  async function pasteBlockFromClipboard() {
    try {
      const ws = _Blockly.getMainWorkspace();
      if (!ws) return;

      const json = await navigator.clipboard.readText();
      if (!json) return;

      let data = JSON.parse(json);

      data = sanitizeForWorkspace(ws, data);

      const originalX = data.x || 0;
      const originalY = data.y || 0;

      const mouse = getMouseWorkspacePosition(ws);
      const dx = mouse.x - originalX;
      const dy = mouse.y - originalY;

      traverseSerializedBlocks(data, (b) => {
        b.x = (b.x || 0) + dx;
        b.y = (b.y || 0) + dy;
      });

      _Blockly.serialization.blocks.append(data, ws);
    } catch (err) {
      console.error("[CopyPastePlugin] Paste failed:", err);
    }
  }

  const copyItem = {
    id: "copyBlockMenuItem",
    displayText: "Copy - BF6",
    preconditionFn: () => "enabled",
    callback: (scope) => {
      if (scope && scope.block) copyBlockToClipboard(scope.block);
    },
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    weight: 90,
  };

  const pasteItem = {
    id: "pasteBlockMenuItem",
    displayText: "Paste - BF6",
    preconditionFn: () => "enabled",
    callback: () => pasteBlockFromClipboard(),
    scopeType: _Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
    weight: 90,
  };

  plugin.initializeWorkspace = function () {
    try {
      const ws = _Blockly.getMainWorkspace();

      const reg = _Blockly.ContextMenuRegistry.registry;
      if (reg.getItem(copyItem.id)) reg.unregister(copyItem.id);
      if (reg.getItem(pasteItem.id)) reg.unregister(pasteItem.id);

      reg.register(copyItem);
      reg.register(pasteItem);

      attachMouseTracking(ws);
    } catch (err) {
      console.error("[CopyPastePlugin] Initialization failed:", err);
    }
  };
})();
