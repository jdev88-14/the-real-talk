// This is the main code file for the THE REAL TALK Figma plugin
// It handles Figma API commands

// Plugin state
const state = {
  serverPort: 3055, // Default port
};


// Helper function for progress updates
async function sendProgressUpdate(
  commandId,
  commandType,
  status,
  progress,
  totalItems,
  processedItems,
  message,
  payload = null
) {
  const update = {
    type: "command_progress",
    commandId,
    commandType,
    status,
    progress,
    totalItems,
    processedItems,
    message,
    timestamp: Date.now(),
  };

  // Add optional chunk information if present
  if (payload) {
    if (
      payload.currentChunk !== undefined &&
      payload.totalChunks !== undefined
    ) {
      update.currentChunk = payload.currentChunk;
      update.totalChunks = payload.totalChunks;
      update.chunkSize = payload.chunkSize;
    }
    update.payload = payload;
  }

  // Send to UI
  figma.ui.postMessage(update);
  console.log(`Progress update: ${status} - ${progress}% - ${message}`);

  // Yield so the Figma plugin sandbox flushes postMessage to ui.html
  // before the next iteration begins
  await new Promise((resolve) => setTimeout(resolve, 0));

  return update;
}

// Show UI
figma.showUI(__html__, { width: 350, height: 600 });

// Readable text for anything that can be thrown (Error, string, object, null, undefined):
// actual content, type and current command. Never throws.
function describeThrown(thrown, command) {
  let type = typeof thrown;
  let content = "";
  try {
    if (thrown === null) {
      type = "null";
      content = "null";
    } else if (thrown === undefined) {
      type = "undefined";
      content = "undefined";
    } else if (thrown instanceof Error || (type === "object" && typeof thrown.message === "string" && typeof thrown.name === "string")) {
      type = thrown.name || "Error";
      content = thrown.message || "(empty message)";
    } else if (type === "string") {
      content = thrown || "(empty text)";
    } else if (type === "object") {
      type = (thrown.constructor && thrown.constructor.name) || "object";
      try {
        content = JSON.stringify(thrown);
      } catch (e) {
        content = String(thrown);
      }
    } else {
      content = String(thrown);
    }
  } catch (e) {
    content = "(contenu illisible)";
  }
  if (typeof content !== "string" || content === "") content = "(contenu vide)";
  if (content.length > 2000) content = content.slice(0, 2000) + "…";
  return `${content} [thrown type: ${type}] [command: ${command || "unknown"}]`;
}

// Plugin commands from UI
figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "update-settings":
      updateSettings(msg);
      break;
    case "notify":
      figma.notify(msg.message);
      break;
    case "close-plugin":
      figma.closePlugin();
      break;
    case "execute-command":
      // Execute commands received from UI (which gets them from WebSocket)
      try {
        const result = await handleCommand(msg.command, msg.params, msg.id);
        figma.ui.postMessage({
          type: "command-result",
          id: msg.id,
          result,
        });
      } catch (error) {
        figma.ui.postMessage({
          type: "command-error",
          id: msg.id,
          error: describeThrown(error, msg.command),
        });
      }
      break;
  }
};

// Update plugin settings
function updateSettings(settings) {
  if (settings.serverPort) {
    state.serverPort = settings.serverPort;
  }
  if (settings.relayToken) {
    figma.clientStorage.setAsync("relayToken", settings.relayToken);
  }

  figma.clientStorage.setAsync("settings", {
    serverPort: state.serverPort,
  });
}

// Handle commands from UI
async function handleCommand(command, params, commandId) {
  if (Object.prototype.hasOwnProperty.call(X_COMMANDS, command)) return await X_COMMANDS[command](params || {});
  switch (command) {
    case "get_document_info":
      return await getDocumentInfo();
    case "get_selection":
      return await getSelection();
    case "get_node_info":
      if (!params || !params.nodeId) {
        throw new Error("Missing nodeId parameter");
      }
      return await getNodeInfo(
        params.nodeId,
        Number.isInteger(params.depth) && params.depth >= 0 ? params.depth : 1,
        params
      );
    case "get_nodes_info":
      if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
        throw new Error("Missing or invalid nodeIds parameter");
      }
      return await getNodesInfo(params.nodeIds, params);
    case "read_my_design":
      return await readMyDesign();
    case "create_rectangle":
      return await createRectangle(params);
    case "create_frame":
      return await createFrame(params);
    case "create_text":
      return await createText(params);
    case "set_fill_color":
      return await setFillColor(params);
    case "set_stroke_color":
      return await setStrokeColor(params);
    case "move_node":
      return await moveNode(params);
    case "resize_node":
      return await resizeNode(params);
    case "delete_node":
      return await deleteNode(params);
    case "delete_multiple_nodes":
      return await deleteMultipleNodes(params);
    case "get_styles":
      return await getStyles();
    case "get_local_components":
      return await getLocalComponents(params);
    // case "get_team_components":
    //   return await getTeamComponents();
    case "create_component_instance":
      return await createComponentInstance(params);
    case "export_node_as_image":
      return await exportNodeAsImage(params);
    case "set_corner_radius":
      return await setCornerRadius(params);
    case "set_text_content":
      return await setTextContent(params);
    case "clone_node":
      return await cloneNode(params);
    case "scan_text_nodes":
      return await scanTextNodes(params);
    case "set_multiple_text_contents":
      return await setMultipleTextContents(params);
    case "get_annotations":
      return await getAnnotations(params);
    case "set_annotation":
      return await setAnnotation(params);
    case "scan_nodes_by_types":
      return await scanNodesByTypes(params);
    case "set_multiple_annotations":
      return await setMultipleAnnotations(params);
    case "get_instance_overrides":
      // Check if instanceNode parameter is provided
      if (params && params.instanceNodeId) {
        // Get the instance node by ID
        const instanceNode = await figma.getNodeByIdAsync(params.instanceNodeId);
        if (!instanceNode) {
          throw new Error(`Instance node not found with ID: ${params.instanceNodeId}`);
        }
        return await getInstanceOverrides(instanceNode);
      }
      // Call without instance node if not provided
      return await getInstanceOverrides();

    case "set_instance_overrides":
      // Check if instanceNodeIds parameter is provided
      if (params && params.targetNodeIds) {
        // Validate that targetNodeIds is an array
        if (!Array.isArray(params.targetNodeIds)) {
          throw new Error("targetNodeIds must be an array");
        }

        // Get the instance nodes by IDs
        const targetNodes = await getValidTargetInstances(params.targetNodeIds);
        if (!targetNodes.success) {
          figma.notify(targetNodes.message);
          return { success: false, message: targetNodes.message };
        }

        if (params.sourceInstanceId) {

          // get source instance data
          let sourceInstanceData = null;
          sourceInstanceData = await getSourceInstanceData(params.sourceInstanceId);

          if (!sourceInstanceData.success) {
            figma.notify(sourceInstanceData.message);
            return { success: false, message: sourceInstanceData.message };
          }
          return await setInstanceOverrides(targetNodes.targetInstances, sourceInstanceData);
        } else {
          throw new Error("Missing sourceInstanceId parameter");
        }
      }
    case "set_layout_mode":
      return await setLayoutMode(params);
    case "set_padding":
      return await setPadding(params);
    case "set_axis_align":
      return await setAxisAlign(params);
    case "set_layout_sizing":
      return await setLayoutSizing(params);
    case "set_item_spacing":
      return await setItemSpacing(params);
    case "get_reactions":
      if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
        throw new Error("Missing or invalid nodeIds parameter");
      }
      return await getReactions(params.nodeIds);  
    case "set_default_connector":
      return await setDefaultConnector(params);
    case "create_connections":
      return await createConnections(params);
    case "set_focus":
      return await setFocus(params);
    case "set_selections":
      return await setSelections(params);
    case "set_image_fill":
      return await setImageFill(params);
    case "rename_node":
      return await renameNode(params);
    case "create_section":
      return await createSection(params);
    case "set_parent":
      return await setParent(params);
    case "create_variable_collection":
      return await createVariableCollection(params);
    case "create_variable":
      return await createVariable(params);
    case "set_variable_value":
      return await setVariableValue(params);
    case "set_variable_scopes":
      return await setVariableScopes(params);
    case "set_variable_description":
      return await setVariableDescription(params);
    case "bind_variable":
      return await bindVariable(params);
    case "create_page":
      return await createPage(params);
    case "set_instance_properties":
      return await setInstanceProperties(params);
    case "convert_to_component":
      return await convertToComponent(params);
    case "combine_as_variants":
      return await combineAsVariants(params);
    case "add_component_property":
      return await addComponentProperty(params);
    case "set_component_property_reference":
      return await setComponentPropertyReference(params);
    case "set_stroke_options":
      return await setStrokeOptions(params);
    case "set_corner_radii":
      return await setCornerRadii(params);
    case "set_layout_positioning":
      return await setLayoutPositioning(params);
    case "create_text_style":
      return await createTextStyle(params);
    case "rename_variable_collection":
      return await renameVariableCollection(params);
    case "get_clips_content":
      return await getClipsContent(params);
    case "set_clips_content":
      return await setClipsContent(params);
    case "clear_fills":
      return await clearFills(params);
    case "set_explicit_variable_mode":
      return await setExplicitVariableMode(params);
    case "set_text_style":
      return await setTextStyle(params);
    case "build_tree":
      return await buildTree(params);
    case "get_local_variables":
      return await getLocalVariables(commandId, params);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// Command implementations

async function getDocumentInfo() {
  await figma.currentPage.loadAsync();
  const page = figma.currentPage;
  return {
    name: page.name,
    id: page.id,
    type: page.type,
    children: page.children.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
    })),
    currentPage: {
      id: page.id,
      name: page.name,
      childCount: page.children.length,
    },
    pages: [
      {
        id: page.id,
        name: page.name,
        childCount: page.children.length,
      },
    ],
  };
}

async function getSelection() {
  return {
    selectionCount: figma.currentPage.selection.length,
    selection: figma.currentPage.selection.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible,
    })),
  };
}

function rgbaToHex(color) {
  var r = Math.round(color.r * 255);
  var g = Math.round(color.g * 255);
  var b = Math.round(color.b * 255);
  var a = color.a !== undefined ? Math.round(color.a * 255) : 255;

  if (a === 255) {
    return (
      "#" +
      [r, g, b]
        .map((x) => {
          return x.toString(16).padStart(2, "0");
        })
        .join("")
    );
  }

  return (
    "#" +
    [r, g, b, a]
      .map((x) => {
        return x.toString(16).padStart(2, "0");
      })
      .join("")
  );
}

// depth: number of child levels kept under this node (Infinity = all, original behavior).
// Beyond that, children are omitted and replaced by childrenCount.
function filterFigmaNode(node, depth = Infinity) {
  if (node.type === "VECTOR") {
    return null;
  }

  var filtered = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.fills && node.fills.length > 0) {
    filtered.fills = node.fills.map((fill) => {
      var processedFill = Object.assign({}, fill);
      delete processedFill.boundVariables;
      delete processedFill.imageRef;

      if (processedFill.gradientStops) {
        processedFill.gradientStops = processedFill.gradientStops.map(
          (stop) => {
            var processedStop = Object.assign({}, stop);
            if (processedStop.color) {
              processedStop.color = rgbaToHex(processedStop.color);
            }
            delete processedStop.boundVariables;
            return processedStop;
          }
        );
      }

      if (processedFill.color) {
        processedFill.color = rgbaToHex(processedFill.color);
      }

      return processedFill;
    });
  }

  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke) => {
      var processedStroke = Object.assign({}, stroke);
      delete processedStroke.boundVariables;
      if (processedStroke.color) {
        processedStroke.color = rgbaToHex(processedStroke.color);
      }
      return processedStroke;
    });
  }

  if (node.cornerRadius !== undefined) {
    filtered.cornerRadius = node.cornerRadius;
  }

  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }

  if (node.characters) {
    filtered.characters = node.characters;
  }

  if (node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx,
    };
  }

  if (node.children) {
    if (depth > 0) {
      filtered.children = node.children
        .map((child) => {
          return filterFigmaNode(child, depth - 1);
        })
        .filter((child) => {
          return child !== null;
        });
    } else if (node.children.length > 0) {
      filtered.childrenCount = node.children.length;
    }
  }

  return filtered;
}

// For each fill and each stroke of the filtered result, adds `variable`: {id, name} of the bound
// variable (read from the live node), or null if the paint is not bound to any variable.
// No design content is logged here.
async function annotateBoundVariables(filtered) {
  if (!filtered) return filtered;
  const names = {};
  const localVars = await lmLocalVariableMap();
  async function varInfo(id) {
    if (!(id in names)) {
      let v = localVars.get(id) || null;
      if (!v) { try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) { v = null; } }
      names[id] = v ? { id, name: v.name } : { id, name: null };
    }
    return names[id];
  }
  async function paintInfo(livePaints, outPaints) {
    if (!Array.isArray(livePaints) || !Array.isArray(outPaints)) return;
    for (let i = 0; i < outPaints.length; i++) {
      const bv = livePaints[i] && livePaints[i].boundVariables;
      const alias = bv && bv.color;
      outPaints[i].variable = alias && alias.id ? await varInfo(alias.id) : null;
    }
  }
  const styleNames = {};
  async function walk(out) {
    {
      const liveN = await figma.getNodeByIdAsync(out.id);
      if (liveN && liveN.type === "TEXT") {
        const sid = liveN.textStyleId;
        if (sid === figma.mixed) {
          out.textStyle = { id: "mixed", name: null };
        } else if (sid) {
          if (!(sid in styleNames)) {
            let st = null;
            try { st = await figma.getStyleByIdAsync(sid); } catch (e) { st = null; }
            styleNames[sid] = st ? st.name : null;
          }
          out.textStyle = { id: sid, name: styleNames[sid] };
        } else {
          out.textStyle = null;
        }
      }
      if (liveN) {
        const ex = {};
        if ("topLeftRadius" in liveN) ex.radii = [liveN.topLeftRadius, liveN.topRightRadius, liveN.bottomRightRadius, liveN.bottomLeftRadius];
        if (liveN.strokes && liveN.strokes.length) { ex.strokeAlign = liveN.strokeAlign; ex.strokeWeight = liveN.strokeWeight; }
        if (liveN.layoutPositioning && liveN.layoutPositioning !== "AUTO") { ex.layoutPositioning = liveN.layoutPositioning; if (liveN.constraints) ex.constraints = liveN.constraints; }
        if ("layoutSizingHorizontal" in liveN) { ex.sizing = [liveN.layoutSizingHorizontal, liveN.layoutSizingVertical]; }
        if (typeof liveN.opacity === "number" && liveN.opacity !== 1) ex.opacity = liveN.opacity;
        if (liveN.effects && liveN.effects.length) ex.effects = liveN.effects.length;
        if (liveN.layoutMode && liveN.layoutMode !== "NONE") { ex.primaryAlign = liveN.primaryAxisAlignItems; ex.counterAlign = liveN.counterAxisAlignItems; }
        if (liveN.type === "COMPONENT_SET") ex.componentPropertyDefinitions = liveN.componentPropertyDefinitions;
        if (liveN.type === "COMPONENT") { ex.variantProperties = liveN.variantProperties; }
        if (liveN.type === "INSTANCE") {
          ex.componentProperties = liveN.componentProperties;
          try { const mc = await liveN.getMainComponentAsync(); if (mc) ex.mainComponentId = mc.id; } catch (e) {}
        }
        if (liveN.componentPropertyReferences && Object.keys(liveN.componentPropertyReferences).length) ex.componentPropertyReferences = liveN.componentPropertyReferences;
        if (liveN.explicitVariableModes && Object.keys(liveN.explicitVariableModes).length) {
          ex.explicitModes = [];
          for (const [cid, mid] of Object.entries(liveN.explicitVariableModes)) {
            try {
              const col = await figma.variables.getVariableCollectionByIdAsync(cid);
              ex.explicitModes.push({ collection: col ? col.name : cid, mode: col ? ((col.modes.find((m) => m.modeId === mid) || {}).name || mid) : mid });
            } catch (e) { ex.explicitModes.push({ collection: cid, mode: mid }); }
          }
        }
        if (Object.keys(ex).length) out.extra = ex;
      }
      if (liveN && liveN.type !== "TEXT" && "clipsContent" in liveN) {
        out.clipsContent = liveN.clipsContent;
      }
      if (liveN && liveN.layoutMode && liveN.layoutMode !== "NONE") {
        out.layout = {
          mode: liveN.layoutMode, paddingTop: liveN.paddingTop, paddingBottom: liveN.paddingBottom,
          paddingLeft: liveN.paddingLeft, paddingRight: liveN.paddingRight, itemSpacing: liveN.itemSpacing,
        };
      }
      if (liveN && liveN.boundVariables) {
        const bvOut = {};
        for (const k of Object.keys(liveN.boundVariables)) {
          if (["fills", "strokes", "effects", "layoutGrids", "componentProperties", "textRangeFills"].includes(k)) continue;
          const al = liveN.boundVariables[k];
          if (al && !Array.isArray(al) && al.id) bvOut[k] = await varInfo(al.id);
        }
        if (Object.keys(bvOut).length) out.boundVariables = bvOut;
      }
    }
    if ((out.fills && out.fills.length) || (out.strokes && out.strokes.length)) {
      const live = await figma.getNodeByIdAsync(out.id);
      if (live) {
        if (out.fills && live.fills !== figma.mixed) await paintInfo(live.fills, out.fills);
        if (out.strokes && live.strokes !== figma.mixed) await paintInfo(live.strokes, out.strokes);
      }
    }
    if (out.children) for (const c of out.children) await walk(c);
  }
  await walk(filtered);
  return filtered;
}

// "Live node" version of filterFigmaNode: reads only the requested depth (the JSON_REST_V1
// export serialized the whole subtree whatever the depth). Stops at the time budget:
// unread children are then omitted and reported (truncated).
function liveFilterNode(node, depth, ctl) {
  if (node.type === "VECTOR") return null;
  ctl.count++;
  const filtered = { id: node.id, name: node.name, type: node.type };
  function paints(list) {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    return list.map((pt) => {
      const o = Object.assign({}, pt);
      delete o.boundVariables;
      delete o.imageHash;
      if (o.gradientStops) o.gradientStops = o.gradientStops.map((st) => ({ position: st.position, color: rgbaToHex(st.color) }));
      if (o.color) o.color = rgbaToHex(o.color);
      return o;
    });
  }
  const fills = "fills" in node ? paints(node.fills === figma.mixed ? [] : node.fills) : undefined;
  if (fills) filtered.fills = fills;
  const strokes = "strokes" in node ? paints(node.strokes === figma.mixed ? [] : node.strokes) : undefined;
  if (strokes) filtered.strokes = strokes;
  if ("cornerRadius" in node && node.cornerRadius !== figma.mixed) filtered.cornerRadius = node.cornerRadius;
  if (node.absoluteBoundingBox) filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  if (node.type === "TEXT") {
    if (node.characters) filtered.characters = node.characters;
    const fn = node.fontName;
    const lh = node.lineHeight;
    filtered.style = {
      fontFamily: fn !== figma.mixed ? fn.family : "mixed",
      fontStyle: fn !== figma.mixed ? fn.style : "mixed",
      fontSize: node.fontSize === figma.mixed ? "mixed" : node.fontSize,
      textAlignHorizontal: node.textAlignHorizontal,
      letterSpacing: node.letterSpacing === figma.mixed ? "mixed" : node.letterSpacing,
      lineHeight: lh === figma.mixed ? "mixed" : lh,
    };
    if (lh !== figma.mixed && lh) {
      if (lh.unit === "PIXELS") filtered.style.lineHeightPx = lh.value;
      else if (lh.unit === "PERCENT" && typeof node.fontSize === "number") filtered.style.lineHeightPx = (lh.value * node.fontSize) / 100;
    }
  }
  if ("children" in node) {
    if (depth > 0 && Date.now() <= ctl.deadline) {
      const kids = [];
      for (const child of node.children) {
        if (Date.now() > ctl.deadline) { ctl.truncated = true; break; }
        const f = liveFilterNode(child, depth - 1, ctl);
        if (f) kids.push(f);
      }
      filtered.children = kids;
      if (ctl.truncated && kids.length < node.children.length) filtered.childrenOmitted = node.children.length - kids.length;
    } else if (node.children.length > 0) {
      filtered.childrenCount = node.children.length;
      if (depth > 0) ctl.truncated = true;
    }
  }
  return filtered;
}

async function getNodeInfo(nodeId, depth = 1, params) {
  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  const ctl = { deadline: Date.now() + lmBudget(params), count: 0, truncated: false };
  const out = await annotateBoundVariables(liveFilterNode(node, depth, ctl));
  if (out) {
    out.nodesRead = ctl.count;
    if (ctl.truncated) {
      out.partial = true;
      out.partialReason = "time budget reached: some children are omitted (childrenOmitted) or unread (childrenCount); retry with a lower depth or on a child";
    }
  }
  return out;
}

async function getNodesInfo(nodeIds, params) {
  try {
    const deadline = Date.now() + lmBudget(params);
    const depth = params && Number.isInteger(params.depth) && params.depth >= 0 ? params.depth : Infinity;
    const responses = [];
    const notFound = [];
    for (const id of nodeIds) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node) { notFound.push(id); continue; }
      const ctl = { deadline, count: 0, truncated: false };
      const doc = await annotateBoundVariables(liveFilterNode(node, depth, ctl));
      const item = { nodeId: node.id, document: doc };
      if (ctl.truncated) { item.partial = true; item.partialReason = "time budget reached for this node"; }
      responses.push(item);
      if (Date.now() > deadline) break;
    }
    // Nodes never read for lack of time: listed, never silently dropped.
    const processed = new Set(responses.map((r) => r.nodeId).concat(notFound));
    const unprocessed = nodeIds.filter((id) => !processed.has(id));
    if (unprocessed.length || notFound.length) {
      return { results: responses, complete: unprocessed.length === 0 && !responses.some((r) => r.partial), unprocessed, notFound };
    }
    if (responses.some((r) => r.partial)) return { results: responses, complete: false, unprocessed: [], notFound: [] };
    return responses;
  } catch (error) {
    throw new Error(`Error getting nodes info: ${error.message}`);
  }
}

async function getReactions(nodeIds) {
  try {
    const commandId = generateCommandId();
    sendProgressUpdate(
      commandId,
      "get_reactions",
      "started",
      0,
      nodeIds.length,
      0,
      `Starting deep search for reactions in ${nodeIds.length} nodes and their children`
    );

    // Function to find nodes with reactions from the node and all its children
    async function findNodesWithReactions(node, processedNodes = new Set(), depth = 0, results = []) {
      // Skip already processed nodes (prevent circular references)
      if (processedNodes.has(node.id)) {
        return results;
      }
      
      processedNodes.add(node.id);
      
      // Check if the current node has reactions
      let filteredReactions = [];
      if (node.reactions && node.reactions.length > 0) {
        // Filter out reactions with navigation === 'CHANGE_TO'
        filteredReactions = node.reactions.filter(r => {
          // Some reactions may have action or actions array
          if (r.action && r.action.navigation === 'CHANGE_TO') return false;
          if (Array.isArray(r.actions)) {
            // If any action in actions array is CHANGE_TO, exclude
            return !r.actions.some(a => a.navigation === 'CHANGE_TO');
          }
          return true;
        });
      }
      const hasFilteredReactions = filteredReactions.length > 0;
      
      // If the node has filtered reactions, add it to results and apply highlight effect
      if (hasFilteredReactions) {
        results.push({
          id: node.id,
          name: node.name,
          type: node.type,
          depth: depth,
          hasReactions: true,
          reactions: filteredReactions,
          path: getNodePath(node)
        });
        // Apply highlight effect (orange border)
        await highlightNodeWithAnimation(node);
      }
      
      // If node has children, recursively search them
      if (node.children) {
        for (const child of node.children) {
          await findNodesWithReactions(child, processedNodes, depth + 1, results);
        }
      }
      
      return results;
    }
    
    // Function to apply animated highlight effect to a node
    async function highlightNodeWithAnimation(node) {
      // Save original stroke properties
      const originalStrokeWeight = node.strokeWeight;
      const originalStrokes = node.strokes ? [...node.strokes] : [];
      
      try {
        // Apply orange border stroke
        node.strokeWeight = 4;
        node.strokes = [{
          type: 'SOLID',
          color: { r: 1, g: 0.5, b: 0 }, // Orange color
          opacity: 0.8
        }];
        
        // Set timeout for animation effect (restore to original after 1.5 seconds)
        setTimeout(() => {
          try {
            // Restore original stroke properties
            node.strokeWeight = originalStrokeWeight;
            node.strokes = originalStrokes;
          } catch (restoreError) {
            console.error(`Error restoring node stroke: ${restoreError.message}`);
          }
        }, 1500);
      } catch (highlightError) {
        console.error(`Error highlighting node: ${highlightError.message}`);
        // Continue even if highlighting fails
      }
    }
    
    // Get node hierarchy path as a string
    function getNodePath(node) {
      const path = [];
      let current = node;
      
      while (current && current.parent) {
        path.unshift(current.name);
        current = current.parent;
      }
      
      return path.join(' > ');
    }

    // Array to store all results
    let allResults = [];
    let processedCount = 0;
    const totalCount = nodeIds.length;
    
    // Iterate through each node and its children to search for reactions
    for (let i = 0; i < nodeIds.length; i++) {
      try {
        const nodeId = nodeIds[i];
        const node = await figma.getNodeByIdAsync(nodeId);
        
        if (!node) {
          processedCount++;
          sendProgressUpdate(
            commandId,
            "get_reactions",
            "in_progress",
            processedCount / totalCount,
            totalCount,
            processedCount,
            `Node not found: ${nodeId}`
          );
          continue;
        }
        
        // Search for reactions in the node and its children
        const processedNodes = new Set();
        const nodeResults = await findNodesWithReactions(node, processedNodes);
        
        // Add results
        allResults = allResults.concat(nodeResults);
        
        // Update progress
        processedCount++;
        sendProgressUpdate(
          commandId,
          "get_reactions",
          "in_progress",
          processedCount / totalCount,
          totalCount,
          processedCount,
          `Processed node ${processedCount}/${totalCount}, found ${nodeResults.length} nodes with reactions`
        );
      } catch (error) {
        processedCount++;
        sendProgressUpdate(
          commandId,
          "get_reactions",
          "in_progress",
          processedCount / totalCount,
          totalCount,
          processedCount,
          `Error processing node: ${error.message}`
        );
      }
    }

    // Completion update
    sendProgressUpdate(
      commandId,
      "get_reactions",
      "completed",
      1,
      totalCount,
      totalCount,
      `Completed deep search: found ${allResults.length} nodes with reactions.`
    );

    return {
      nodesCount: nodeIds.length,
      nodesWithReactions: allResults.length,
      nodes: allResults
    };
  } catch (error) {
    throw new Error(`Failed to get reactions: ${error.message}`);
  }
}

async function readMyDesign() {
  try {
    // Load all selected nodes in parallel
    const nodes = await Promise.all(
      figma.currentPage.selection.map((node) => figma.getNodeByIdAsync(node.id))
    );

    // Filter out any null values (nodes that weren't found)
    const validNodes = nodes.filter((node) => node !== null);

    // Export all valid nodes in parallel
    const responses = await Promise.all(
      validNodes.map(async (node) => {
        const response = await node.exportAsync({
          format: "JSON_REST_V1",
        });
        return {
          nodeId: node.id,
          document: filterFigmaNode(response.document),
        };
      })
    );

    return responses;
  } catch (error) {
    throw new Error(`Error getting nodes info: ${error.message}`);
  }
}

// Resolves the parent before any creation, so nothing is left behind if resolution fails.
async function resolveParentForCreate(parentId) {
  if (!parentId) return figma.currentPage;
  const parentNode = await figma.getNodeByIdAsync(parentId);
  if (!parentNode) {
    throw new Error(`Parent node not found with ID: ${parentId}`);
  }
  if (!("appendChild" in parentNode)) {
    throw new Error(`Parent node does not support children: ${parentId}`);
  }
  return parentNode;
}

async function createRectangle(params) {
  const {
    x = 0,
    y = 0,
    width = 100,
    height = 100,
    name = "Rectangle",
    parentId,
  } = params || {};

  const parentNode = await resolveParentForCreate(parentId);
  const rect = figma.createRectangle();
  try {
    // Attach to the parent first, then set position and size
    parentNode.appendChild(rect);
    rect.x = x;
    rect.y = y;
    rect.resize(width, height);
    rect.name = name;
  } catch (error) {
    rect.remove();
    throw error;
  }

  return {
    id: rect.id,
    name: rect.name,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    parentId: rect.parent ? rect.parent.id : undefined,
  };
}

async function createFrame(params) {
  // figmaDefaults (build_tree): a property not provided keeps Figma's default value.
  const fd = !!(params && params.figmaDefaults);
  const given = params || {};
  const {
    x = 0,
    y = 0,
    width = 100,
    height = 100,
    name = "Frame",
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
    layoutMode = "NONE",
    layoutWrap = "NO_WRAP",
    paddingTop = 10,
    paddingRight = 10,
    paddingBottom = 10,
    paddingLeft = 10,
    primaryAxisAlignItems = "MIN",
    counterAxisAlignItems = "MIN",
    layoutSizingHorizontal = "FIXED",
    layoutSizingVertical = "FIXED",
    itemSpacing = 0,
  } = params || {};

  const parentNode = await resolveParentForCreate(parentId);
  const frame = figma.createFrame();
  try {
    // Attach to the parent first: FILL is only allowed on a child of an auto layout frame
    parentNode.appendChild(frame);
    frame.x = x;
    frame.y = y;
    frame.resize(width, height);
    frame.name = name;

    // Set layout mode if provided
    if (layoutMode !== "NONE") {
      frame.layoutMode = layoutMode;
      if (!fd || given.layoutWrap !== undefined) frame.layoutWrap = layoutWrap;

      // Padding, alignment and spacing: Figma's values if figmaDefaults and nothing provided
      if (!fd || given.paddingTop !== undefined) frame.paddingTop = paddingTop;
      if (!fd || given.paddingRight !== undefined) frame.paddingRight = paddingRight;
      if (!fd || given.paddingBottom !== undefined) frame.paddingBottom = paddingBottom;
      if (!fd || given.paddingLeft !== undefined) frame.paddingLeft = paddingLeft;
      if (!fd || given.primaryAxisAlignItems !== undefined) frame.primaryAxisAlignItems = primaryAxisAlignItems;
      if (!fd || given.counterAxisAlignItems !== undefined) frame.counterAxisAlignItems = counterAxisAlignItems;
      if (!fd || given.itemSpacing !== undefined) frame.itemSpacing = itemSpacing;
    }

    // Size (FIXED, HUG or FILL): after attaching and after the auto layout mode.
    // figmaDefaults: with no size provided, Figma keeps its own; an explicit width or height
    // stays fixed.
    if (fd) {
      if (given.layoutSizingHorizontal !== undefined) frame.layoutSizingHorizontal = given.layoutSizingHorizontal;
      else if (layoutMode !== "NONE" && given.width !== undefined) frame.layoutSizingHorizontal = "FIXED";
      if (given.layoutSizingVertical !== undefined) frame.layoutSizingVertical = given.layoutSizingVertical;
      else if (layoutMode !== "NONE" && given.height !== undefined) frame.layoutSizingVertical = "FIXED";
    } else {
      if (layoutMode !== "NONE" || layoutSizingHorizontal !== "FIXED") {
        frame.layoutSizingHorizontal = layoutSizingHorizontal;
      }
      if (layoutMode !== "NONE" || layoutSizingVertical !== "FIXED") {
        frame.layoutSizingVertical = layoutSizingVertical;
      }
    }

    // Set fill color if provided
    if (fillColor) {
      const paintStyle = {
        type: "SOLID",
        color: {
          r: parseFloat(fillColor.r) || 0,
          g: parseFloat(fillColor.g) || 0,
          b: parseFloat(fillColor.b) || 0,
        },
        opacity: parseFloat(fillColor.a) || 1,
      };
      frame.fills = [paintStyle];
    }

    // Set stroke color and weight if provided
    if (strokeColor) {
      const strokeStyle = {
        type: "SOLID",
        color: {
          r: parseFloat(strokeColor.r) || 0,
          g: parseFloat(strokeColor.g) || 0,
          b: parseFloat(strokeColor.b) || 0,
        },
        opacity: parseFloat(strokeColor.a) || 1,
      };
      frame.strokes = [strokeStyle];
    }

    // Set stroke weight if provided
    if (strokeWeight !== undefined) {
      frame.strokeWeight = strokeWeight;
    }
  } catch (error) {
    // No orphan frame on failure
    frame.remove();
    throw error;
  }

  return {
    id: frame.id,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    fills: frame.fills,
    strokes: frame.strokes,
    strokeWeight: frame.strokeWeight,
    layoutMode: frame.layoutMode,
    layoutWrap: frame.layoutWrap,
    parentId: frame.parent ? frame.parent.id : undefined,
  };
}

async function createText(params) {
  // figmaDefaults (build_tree) : taille et couleur non fournies restent celles de Figma.
  const fdText = !!(params && params.figmaDefaults);
  const givenText = params || {};
  const {
    x = 0,
    y = 0,
    text = "Text",
    fontSize = 14,
    fontWeight = 400,
    fontColor = { r: 0, g: 0, b: 0, a: 1 }, // Default to black
    name = "",
    parentId,
  } = params || {};

  // Map common font weights to Figma font styles
  const getFontStyle = (weight) => {
    switch (weight) {
      case 100:
        return "Thin";
      case 200:
        return "Extra Light";
      case 300:
        return "Light";
      case 400:
        return "Regular";
      case 500:
        return "Medium";
      case 600:
        return "Semi Bold";
      case 700:
        return "Bold";
      case 800:
        return "Extra Bold";
      case 900:
        return "Black";
      default:
        return "Regular";
    }
  };

  const parentNode = await resolveParentForCreate(parentId);
  const textNode = figma.createText();
  try {
    // Attach to the parent first, then set the rest
    parentNode.appendChild(textNode);
    textNode.x = x;
    textNode.y = y;
    textNode.name = name || text;
    try {
      await figma.loadFontAsync({
        family: "Inter",
        style: getFontStyle(fontWeight),
      });
      textNode.fontName = { family: "Inter", style: getFontStyle(fontWeight) };
      if (!fdText || givenText.fontSize !== undefined) textNode.fontSize = parseInt(fontSize);
    } catch (error) {
      console.error("Error setting font size", error);
    }
    setCharacters(textNode, text);

    // Set text color
    const paintStyle = {
      type: "SOLID",
      color: {
        r: parseFloat(fontColor.r) || 0,
        g: parseFloat(fontColor.g) || 0,
        b: parseFloat(fontColor.b) || 0,
      },
      opacity: parseFloat(fontColor.a) || 1,
    };
    if (!fdText || givenText.fontColor !== undefined) textNode.fills = [paintStyle];
  } catch (error) {
    textNode.remove();
    throw error;
  }

  return {
    id: textNode.id,
    name: textNode.name,
    x: textNode.x,
    y: textNode.y,
    width: textNode.width,
    height: textNode.height,
    characters: textNode.characters,
    fontSize: textNode.fontSize,
    fontWeight: fontWeight,
    fontColor: fontColor,
    fontName: textNode.fontName,
    fills: textNode.fills,
    parentId: textNode.parent ? textNode.parent.id : undefined,
  };
}

async function setFillColor(params) {
  console.log("setFillColor", params);
  const {
    nodeId,
    color: { r, g, b, a },
  } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("fills" in node)) {
    throw new Error(`Node does not support fills: ${nodeId}`);
  }

  // Create RGBA color
  const rgbColor = {
    r: parseFloat(r) || 0,
    g: parseFloat(g) || 0,
    b: parseFloat(b) || 0,
    a: parseFloat(a) || 1,
  };

  // Set fill
  const paintStyle = {
    type: "SOLID",
    color: {
      r: parseFloat(rgbColor.r),
      g: parseFloat(rgbColor.g),
      b: parseFloat(rgbColor.b),
    },
    opacity: parseFloat(rgbColor.a),
  };

  console.log("paintStyle", paintStyle);

  node.fills = [paintStyle];

  return {
    id: node.id,
    name: node.name,
    fills: [paintStyle],
  };
}

async function setStrokeColor(params) {
  const {
    nodeId,
    color: { r, g, b, a },
    weight = 1,
  } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("strokes" in node)) {
    throw new Error(`Node does not support strokes: ${nodeId}`);
  }

  // Create RGBA color
  const rgbColor = {
    r: r !== undefined ? r : 0,
    g: g !== undefined ? g : 0,
    b: b !== undefined ? b : 0,
    a: a !== undefined ? a : 1,
  };

  // Set stroke
  const paintStyle = {
    type: "SOLID",
    color: {
      r: rgbColor.r,
      g: rgbColor.g,
      b: rgbColor.b,
    },
    opacity: rgbColor.a,
  };

  node.strokes = [paintStyle];

  // Set stroke weight if available
  if ("strokeWeight" in node) {
    node.strokeWeight = weight;
  }

  return {
    id: node.id,
    name: node.name,
    strokes: node.strokes,
    strokeWeight: "strokeWeight" in node ? node.strokeWeight : undefined,
  };
}

async function setImageFill(params) {
  const { nodeId, imageBase64, scaleMode = "FILL" } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (!imageBase64) {
    throw new Error("Missing imageBase64 parameter");
  }

  const validScaleModes = ["FILL", "FIT", "CROP", "TILE"];
  if (validScaleModes.indexOf(scaleMode) === -1) {
    throw new Error(
      `Invalid scaleMode: ${scaleMode}. Must be one of: ${validScaleModes.join(", ")}`
    );
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("fills" in node)) {
    throw new Error(`Node does not support fills: ${nodeId}`);
  }

  const bytes = base64ToUint8Array(imageBase64);

  let image;
  try {
    image = figma.createImage(bytes);
  } catch (error) {
    throw new Error(
      `Figma rejected the image (supported: PNG/JPG/GIF/WEBP up to 4096x4096): ${error.message}`
    );
  }

  node.fills = [
    {
      type: "IMAGE",
      imageHash: image.hash,
      scaleMode: scaleMode,
    },
  ];

  let imageWidth;
  let imageHeight;
  try {
    const size = await image.getSizeAsync();
    imageWidth = size.width;
    imageHeight = size.height;
  } catch (sizeError) {
    // Size lookup is informational only
  }

  return {
    id: node.id,
    name: node.name,
    imageHash: image.hash,
    scaleMode: scaleMode,
    imageWidth: imageWidth,
    imageHeight: imageHeight,
  };
}

// Decode base64 in the plugin sandbox, where atob is not available
function base64ToUint8Array(base64) {
  if (typeof figma.base64Decode === "function") {
    return figma.base64Decode(base64);
  }

  const base64Chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const length = clean.length;
  const bytes = new Uint8Array(Math.floor((length * 3) / 4));

  let byteIndex = 0;
  for (let i = 0; i < length; i += 4) {
    const a = base64Chars.indexOf(clean[i]);
    const b = base64Chars.indexOf(clean[i + 1]);
    const c = base64Chars.indexOf(clean[i + 2]);
    const d = base64Chars.indexOf(clean[i + 3]);

    bytes[byteIndex++] = (a << 2) | (b >> 4);
    if (c !== -1) bytes[byteIndex++] = ((b & 15) << 4) | (c >> 2);
    if (d !== -1) bytes[byteIndex++] = ((c & 3) << 6) | d;
  }

  return bytes.slice(0, byteIndex);
}

async function renameNode(params) {
  const { nodeId, name } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (name === undefined || name === null) {
    throw new Error("Missing name parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  const previousName = node.name;
  try {
    node.name = String(name);
  } catch (error) {
    throw new Error(`Cannot rename node: ${error.message}`);
  }

  return {
    id: node.id,
    previousName: previousName,
    name: node.name,
  };
}

async function createSection(params) {
  const {
    x = 0,
    y = 0,
    width = 100,
    height = 100,
    name = "Section",
  } = params || {};

  const section = figma.createSection();
  section.name = name;
  section.x = x;
  section.y = y;
  section.resizeWithoutConstraints(width, height);

  return {
    id: section.id,
    name: section.name,
    x: section.x,
    y: section.y,
    width: section.width,
    height: section.height,
  };
}

async function setParent(params) {
  const { nodeId, parentId, x, y, index } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (!parentId) {
    throw new Error("Missing parentId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  const parentNode = await figma.getNodeByIdAsync(parentId);
  if (!parentNode) {
    throw new Error(`Parent node not found with ID: ${parentId}`);
  }

  if (!("appendChild" in parentNode)) {
    throw new Error(`Parent node does not support children: ${parentId}`);
  }

  // Refuse to create a cycle
  let ancestor = parentNode;
  while (ancestor) {
    if (ancestor.id === node.id) {
      throw new Error("Cannot move a node into its own subtree");
    }
    ancestor = ancestor.parent;
  }

  // Capture the absolute position so it can be preserved across the move
  const hasAbsolute = "absoluteTransform" in node;
  const absoluteX = hasAbsolute ? node.absoluteTransform[0][2] : undefined;
  const absoluteY = hasAbsolute ? node.absoluteTransform[1][2] : undefined;

  if (index !== undefined) {
    parentNode.insertChild(index, node);
  } else {
    parentNode.appendChild(node);
  }

  if (x !== undefined && y !== undefined) {
    node.x = x;
    node.y = y;
  } else if (hasAbsolute && "x" in node) {
    const parentAbsoluteX =
      "absoluteTransform" in parentNode ? parentNode.absoluteTransform[0][2] : 0;
    const parentAbsoluteY =
      "absoluteTransform" in parentNode ? parentNode.absoluteTransform[1][2] : 0;
    node.x = absoluteX - parentAbsoluteX;
    node.y = absoluteY - parentAbsoluteY;
  }

  return {
    id: node.id,
    name: node.name,
    parentId: parentNode.id,
    parentName: parentNode.name,
    x: "x" in node ? node.x : undefined,
    y: "y" in node ? node.y : undefined,
    index: parentNode.children.indexOf(node),
  };
}

async function moveNode(params) {
  const { nodeId, x, y } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (x === undefined || y === undefined) {
    throw new Error("Missing x or y parameters");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("x" in node) || !("y" in node)) {
    throw new Error(`Node does not support position: ${nodeId}`);
  }

  node.x = x;
  node.y = y;

  return {
    id: node.id,
    name: node.name,
    x: node.x,
    y: node.y,
  };
}

async function resizeNode(params) {
  const { nodeId, width, height } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (width === undefined || height === undefined) {
    throw new Error("Missing width or height parameters");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("resize" in node)) {
    throw new Error(`Node does not support resizing: ${nodeId}`);
  }

  node.resize(width, height);

  return {
    id: node.id,
    name: node.name,
    width: node.width,
    height: node.height,
  };
}

async function deleteNode(params) {
  const { nodeId } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Save node info before deleting
  const nodeInfo = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  node.remove();

  return nodeInfo;
}

async function getStyles() {
  const styles = {
    colors: await figma.getLocalPaintStylesAsync(),
    texts: await figma.getLocalTextStylesAsync(),
    effects: await figma.getLocalEffectStylesAsync(),
    grids: await figma.getLocalGridStylesAsync(),
  };

  return {
    colors: styles.colors.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      paint: style.paints[0],
    })),
    texts: styles.texts.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      fontSize: style.fontSize,
      fontName: style.fontName,
    })),
    effects: styles.effects.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
    grids: styles.grids.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
  };
}

async function getLocalComponents(params) {
  const commandId = (params && params.commandId) || generateCommandId();
  const pages = figma.root.children;
  const totalPages = pages.length;

  await sendProgressUpdate(
    commandId,
    "get_local_components",
    "started",
    0,
    totalPages,
    0,
    "Starting component scan across " + totalPages + " pages...",
    null
  );

  var allComponents = [];

  for (var i = 0; i < totalPages; i++) {
    var page = pages[i];
    await page.loadAsync();

    var pageComponents = page.findAllWithCriteria({ types: ["COMPONENT"] });

    for (var j = 0; j < pageComponents.length; j++) {
      var component = pageComponents[j];
      allComponents.push({
        id: component.id,
        name: component.name,
        key: "key" in component ? component.key : null,
      });
    }

    var progress = Math.round(((i + 1) / totalPages) * 100);
    await sendProgressUpdate(
      commandId,
      "get_local_components",
      "in_progress",
      progress,
      totalPages,
      i + 1,
      "Scanned " + page.name + ": " + pageComponents.length + " components (total so far: " + allComponents.length + ")",
      null
    );
  }

  await sendProgressUpdate(
    commandId,
    "get_local_components",
    "completed",
    100,
    totalPages,
    totalPages,
    "Found " + allComponents.length + " components across " + totalPages + " pages",
    null
  );

  return {
    count: allComponents.length,
    components: allComponents,
  };
}

// async function getTeamComponents() {
//   try {
//     const teamComponents =
//       await figma.teamLibrary.getAvailableComponentsAsync();

//     return {
//       count: teamComponents.length,
//       components: teamComponents.map((component) => ({
//         key: component.key,
//         name: component.name,
//         description: component.description,
//         libraryName: component.libraryName,
//       })),
//     };
//   } catch (error) {
//     throw new Error(`Error getting team components: ${error.message}`);
//   }
// }

async function createComponentInstance(params) {
  const { componentKey, componentId, x = 0, y = 0, parentId } = params || {};

  if (!componentKey && !componentId) {
    throw new Error("Missing componentKey or componentId parameter. Use componentId for local components (from get_local_components), or componentKey for published library components.");
  }

  try {
    let component;

    if (componentId) {
      // Local component: get node directly by ID
      const node = await figma.getNodeByIdAsync(componentId);
      if (!node) {
        throw new Error(`Component node not found with id: ${componentId}`);
      }
      if (node.type !== "COMPONENT") {
        throw new Error(`Node ${componentId} is not a COMPONENT (got type: ${node.type}). Use get_local_components to find valid component IDs.`);
      }
      component = node;
    } else {
      // Published library component: import by key
      component = await figma.importComponentByKeyAsync(componentKey);
    }

    const instance = component.createInstance();
    instance.x = x;
    instance.y = y;

    if (parentId) {
      const parent = await figma.getNodeByIdAsync(parentId);
      if (parent && "appendChild" in parent) {
        parent.appendChild(instance);
      } else {
        figma.currentPage.appendChild(instance);
      }
    } else {
      figma.currentPage.appendChild(instance);
    }

    const mainComponent = await instance.getMainComponentAsync();

    return {
      id: instance.id,
      name: instance.name,
      x: instance.x,
      y: instance.y,
      width: instance.width,
      height: instance.height,
      mainComponentId: mainComponent ? mainComponent.id : undefined,
    };
  } catch (error) {
    throw new Error(`Error creating component instance: ${error.message}`);
  }
}

async function exportNodeAsImage(params) {
  const { nodeId, scale = 1 } = params || {};
  // The requested format is respected (the old version forced PNG).
  const format = params && params.format ? params.format : "PNG";
  if (!["PNG", "JPG", "SVG", "PDF"].includes(format)) throw new Error("format must be PNG, JPG, SVG or PDF");
  if (typeof scale !== "number" || !(scale > 0) || scale > 4) throw new Error("scale must be a number above 0 and at most 4");

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("exportAsync" in node)) {
    throw new Error(`Node does not support exporting: ${nodeId}`);
  }

  try {
    const settings = format === "SVG" || format === "PDF"
      ? { format: format }
      : { format: format, constraint: { type: "SCALE", value: scale } };

    const bytes = await node.exportAsync(settings);

    const mimeType = { PNG: "image/png", JPG: "image/jpeg", SVG: "image/svg+xml", PDF: "application/pdf" }[format];
    const base64 = typeof figma.base64Encode === "function" ? figma.base64Encode(bytes) : customBase64Encode(bytes);

    return {
      nodeId,
      name: node.name,
      format,
      scale,
      mimeType,
      byteLength: bytes.byteLength,
      width: typeof node.width === "number" ? node.width : undefined,
      height: typeof node.height === "number" ? node.height : undefined,
      imageData: base64,
    };
  } catch (error) {
    throw new Error(`Error exporting node as image: ${error.message}`);
  }
}
function customBase64Encode(bytes) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let base64 = "";

  const byteLength = bytes.byteLength;
  const byteRemainder = byteLength % 3;
  const mainLength = byteLength - byteRemainder;

  let a, b, c, d;
  let chunk;

  // Main loop deals with bytes in chunks of 3
  for (let i = 0; i < mainLength; i = i + 3) {
    // Combine the three bytes into a single integer
    chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];

    // Use bitmasks to extract 6-bit segments from the triplet
    a = (chunk & 16515072) >> 18; // 16515072 = (2^6 - 1) << 18
    b = (chunk & 258048) >> 12; // 258048 = (2^6 - 1) << 12
    c = (chunk & 4032) >> 6; // 4032 = (2^6 - 1) << 6
    d = chunk & 63; // 63 = 2^6 - 1

    // Convert the raw binary segments to the appropriate ASCII encoding
    base64 += chars[a] + chars[b] + chars[c] + chars[d];
  }

  // Deal with the remaining bytes and padding
  if (byteRemainder === 1) {
    chunk = bytes[mainLength];

    a = (chunk & 252) >> 2; // 252 = (2^6 - 1) << 2

    // Set the 4 least significant bits to zero
    b = (chunk & 3) << 4; // 3 = 2^2 - 1

    base64 += chars[a] + chars[b] + "==";
  } else if (byteRemainder === 2) {
    chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1];

    a = (chunk & 64512) >> 10; // 64512 = (2^6 - 1) << 10
    b = (chunk & 1008) >> 4; // 1008 = (2^6 - 1) << 4

    // Set the 2 least significant bits to zero
    c = (chunk & 15) << 2; // 15 = 2^4 - 1

    base64 += chars[a] + chars[b] + chars[c] + "=";
  }

  return base64;
}

async function setCornerRadius(params) {
  const { nodeId, radius, corners } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (radius === undefined) {
    throw new Error("Missing radius parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Check if node supports corner radius
  if (!("cornerRadius" in node)) {
    throw new Error(`Node does not support corner radius: ${nodeId}`);
  }

  // If corners array is provided, set individual corner radii
  if (corners && Array.isArray(corners) && corners.length === 4) {
    if ("topLeftRadius" in node) {
      // Node supports individual corner radii
      if (corners[0]) node.topLeftRadius = radius;
      if (corners[1]) node.topRightRadius = radius;
      if (corners[2]) node.bottomRightRadius = radius;
      if (corners[3]) node.bottomLeftRadius = radius;
    } else {
      // Node only supports uniform corner radius
      node.cornerRadius = radius;
    }
  } else {
    // Set uniform corner radius
    node.cornerRadius = radius;
  }

  return {
    id: node.id,
    name: node.name,
    cornerRadius: "cornerRadius" in node ? node.cornerRadius : undefined,
    topLeftRadius: "topLeftRadius" in node ? node.topLeftRadius : undefined,
    topRightRadius: "topRightRadius" in node ? node.topRightRadius : undefined,
    bottomRightRadius:
      "bottomRightRadius" in node ? node.bottomRightRadius : undefined,
    bottomLeftRadius:
      "bottomLeftRadius" in node ? node.bottomLeftRadius : undefined,
  };
}

async function setTextContent(params) {
  const { nodeId, text } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (text === undefined) {
    throw new Error("Missing text parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (node.type !== "TEXT") {
    throw new Error(`Node is not a text node: ${nodeId}`);
  }

  try {
    await figma.loadFontAsync(node.fontName);

    await setCharacters(node, text);

    return {
      id: node.id,
      name: node.name,
      characters: node.characters,
      fontName: node.fontName,
    };
  } catch (error) {
    throw new Error(`Error setting text content: ${error.message}`);
  }
}

// Initialize settings on load
(async function initializePlugin() {
  try {
    const savedSettings = await figma.clientStorage.getAsync("settings");
    if (savedSettings) {
      if (savedSettings.serverPort) {
        state.serverPort = savedSettings.serverPort;
      }
    }

    // Send initial settings to UI: the saved token and port trigger
    // automatic connection on the UI side (autoConnect), without a click.
    figma.ui.postMessage({
      type: "init-settings",
      autoConnect: true,
      fileName: figma.root.name,
      settings: {
        serverPort: state.serverPort,
        relayToken: (await figma.clientStorage.getAsync("relayToken")) || "",
      },
    });
  } catch (error) {
    console.error("Error loading settings:", error);
  }
})();

function uniqBy(arr, predicate) {
  const cb = typeof predicate === "function" ? predicate : (o) => o[predicate];
  return [
    ...arr
      .reduce((map, item) => {
        const key = item === null || item === undefined ? item : cb(item);

        map.has(key) || map.set(key, item);

        return map;
      }, new Map())
      .values(),
  ];
}
const setCharacters = async (node, characters, options) => {
  const fallbackFont = (options && options.fallbackFont) || {
    family: "Inter",
    style: "Regular",
  };
  try {
    if (node.fontName === figma.mixed) {
      if (options && options.smartStrategy === "prevail") {
        const fontHashTree = {};
        for (let i = 1; i < node.characters.length; i++) {
          const charFont = node.getRangeFontName(i - 1, i);
          const key = `${charFont.family}::${charFont.style}`;
          fontHashTree[key] = fontHashTree[key] ? fontHashTree[key] + 1 : 1;
        }
        const prevailedTreeItem = Object.entries(fontHashTree).sort(
          (a, b) => b[1] - a[1]
        )[0];
        const [family, style] = prevailedTreeItem[0].split("::");
        const prevailedFont = {
          family,
          style,
        };
        await figma.loadFontAsync(prevailedFont);
        node.fontName = prevailedFont;
      } else if (options && options.smartStrategy === "strict") {
        return setCharactersWithStrictMatchFont(node, characters, fallbackFont);
      } else if (options && options.smartStrategy === "experimental") {
        return setCharactersWithSmartMatchFont(node, characters, fallbackFont);
      } else {
        const firstCharFont = node.getRangeFontName(0, 1);
        await figma.loadFontAsync(firstCharFont);
        node.fontName = firstCharFont;
      }
    } else {
      await figma.loadFontAsync({
        family: node.fontName.family,
        style: node.fontName.style,
      });
    }
  } catch (err) {
    console.warn(
      `Failed to load "${node.fontName["family"]} ${node.fontName["style"]}" font and replaced with fallback "${fallbackFont.family} ${fallbackFont.style}"`,
      err
    );
    await figma.loadFontAsync(fallbackFont);
    node.fontName = fallbackFont;
  }
  try {
    node.characters = characters;
    return true;
  } catch (err) {
    console.warn(`Failed to set characters. Skipped.`, err);
    return false;
  }
};

const setCharactersWithStrictMatchFont = async (
  node,
  characters,
  fallbackFont
) => {
  const fontHashTree = {};
  for (let i = 1; i < node.characters.length; i++) {
    const startIdx = i - 1;
    const startCharFont = node.getRangeFontName(startIdx, i);
    const startCharFontVal = `${startCharFont.family}::${startCharFont.style}`;
    while (i < node.characters.length) {
      i++;
      const charFont = node.getRangeFontName(i - 1, i);
      if (startCharFontVal !== `${charFont.family}::${charFont.style}`) {
        break;
      }
    }
    fontHashTree[`${startIdx}_${i}`] = startCharFontVal;
  }
  await figma.loadFontAsync(fallbackFont);
  node.fontName = fallbackFont;
  node.characters = characters;
  console.log(fontHashTree);
  await Promise.all(
    Object.keys(fontHashTree).map(async (range) => {
      console.log(range, fontHashTree[range]);
      const [start, end] = range.split("_");
      const [family, style] = fontHashTree[range].split("::");
      const matchedFont = {
        family,
        style,
      };
      await figma.loadFontAsync(matchedFont);
      return node.setRangeFontName(Number(start), Number(end), matchedFont);
    })
  );
  return true;
};

const getDelimiterPos = (str, delimiter, startIdx = 0, endIdx = str.length) => {
  const indices = [];
  let temp = startIdx;
  for (let i = startIdx; i < endIdx; i++) {
    if (
      str[i] === delimiter &&
      i + startIdx !== endIdx &&
      temp !== i + startIdx
    ) {
      indices.push([temp, i + startIdx]);
      temp = i + startIdx + 1;
    }
  }
  temp !== endIdx && indices.push([temp, endIdx]);
  return indices.filter(Boolean);
};

const buildLinearOrder = (node) => {
  const fontTree = [];
  const newLinesPos = getDelimiterPos(node.characters, "\n");
  newLinesPos.forEach(([newLinesRangeStart, newLinesRangeEnd], n) => {
    const newLinesRangeFont = node.getRangeFontName(
      newLinesRangeStart,
      newLinesRangeEnd
    );
    if (newLinesRangeFont === figma.mixed) {
      const spacesPos = getDelimiterPos(
        node.characters,
        " ",
        newLinesRangeStart,
        newLinesRangeEnd
      );
      spacesPos.forEach(([spacesRangeStart, spacesRangeEnd], s) => {
        const spacesRangeFont = node.getRangeFontName(
          spacesRangeStart,
          spacesRangeEnd
        );
        if (spacesRangeFont === figma.mixed) {
          const spacesRangeFont = node.getRangeFontName(
            spacesRangeStart,
            spacesRangeStart[0]
          );
          fontTree.push({
            start: spacesRangeStart,
            delimiter: " ",
            family: spacesRangeFont.family,
            style: spacesRangeFont.style,
          });
        } else {
          fontTree.push({
            start: spacesRangeStart,
            delimiter: " ",
            family: spacesRangeFont.family,
            style: spacesRangeFont.style,
          });
        }
      });
    } else {
      fontTree.push({
        start: newLinesRangeStart,
        delimiter: "\n",
        family: newLinesRangeFont.family,
        style: newLinesRangeFont.style,
      });
    }
  });
  return fontTree
    .sort((a, b) => +a.start - +b.start)
    .map(({ family, style, delimiter }) => ({ family, style, delimiter }));
};

const setCharactersWithSmartMatchFont = async (
  node,
  characters,
  fallbackFont
) => {
  const rangeTree = buildLinearOrder(node);
  const fontsToLoad = uniqBy(
    rangeTree,
    ({ family, style }) => `${family}::${style}`
  ).map(({ family, style }) => ({
    family,
    style,
  }));

  await Promise.all([...fontsToLoad, fallbackFont].map(figma.loadFontAsync));

  node.fontName = fallbackFont;
  node.characters = characters;

  let prevPos = 0;
  rangeTree.forEach(({ family, style, delimiter }) => {
    if (prevPos < node.characters.length) {
      const delimeterPos = node.characters.indexOf(delimiter, prevPos);
      const endPos =
        delimeterPos > prevPos ? delimeterPos : node.characters.length;
      const matchedFont = {
        family,
        style,
      };
      node.setRangeFontName(prevPos, endPos, matchedFont);
      prevPos = endPos + 1;
    }
  });
  return true;
};

// Add the cloneNode function implementation
async function cloneNode(params) {
  const { nodeId, x, y } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Clone the node
  const clone = node.clone();

  // If x and y are provided, move the clone to that position
  if (x !== undefined && y !== undefined) {
    if (!("x" in clone) || !("y" in clone)) {
      throw new Error(`Cloned node does not support position: ${nodeId}`);
    }
    clone.x = x;
    clone.y = y;
  }

  // Add the clone to the same parent as the original node
  if (node.parent) {
    node.parent.appendChild(clone);
  } else {
    figma.currentPage.appendChild(clone);
  }

  return {
    id: clone.id,
    name: clone.name,
    x: "x" in clone ? clone.x : undefined,
    y: "y" in clone ? clone.y : undefined,
    width: "width" in clone ? clone.width : undefined,
    height: "height" in clone ? clone.height : undefined,
  };
}

async function scanTextNodes(params) {
  console.log(`Starting to scan text nodes from node ID: ${params.nodeId}`);
  const {
    nodeId,
    useChunking = true,
    chunkSize = 10,
    commandId = generateCommandId(),
  } = params || {};

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    console.error(`Node with ID ${nodeId} not found`);
    // Send error progress update
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "error",
      0,
      0,
      0,
      `Node with ID ${nodeId} not found`,
      { error: `Node not found: ${nodeId}` }
    );
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // If chunking is not enabled, use the original implementation
  if (!useChunking) {
    const textNodes = [];
    try {
      // Send started progress update
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "started",
        0,
        1, // Not known yet how many nodes there are
        0,
        `Starting scan of node "${node.name || nodeId}" without chunking`,
        null
      );

      await findTextNodes(node, [], 0, textNodes);

      // Send completed progress update
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "completed",
        100,
        textNodes.length,
        textNodes.length,
        `Scan complete. Found ${textNodes.length} text nodes.`,
        { textNodes }
      );

      return {
        success: true,
        message: `Scanned ${textNodes.length} text nodes.`,
        count: textNodes.length,
        textNodes: textNodes,
        commandId,
      };
    } catch (error) {
      console.error("Error scanning text nodes:", error);

      // Send error progress update
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "error",
        0,
        0,
        0,
        `Error scanning text nodes: ${error.message}`,
        { error: error.message }
      );

      throw new Error(`Error scanning text nodes: ${error.message}`);
    }
  }

  // Chunked implementation
  console.log(`Using chunked scanning with chunk size: ${chunkSize}`);

  // First, collect all nodes to process (without processing them yet)
  const nodesToProcess = [];

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "started",
    0,
    0, // Not known yet how many nodes there are
    0,
    `Starting chunked scan of node "${node.name || nodeId}"`,
    { chunkSize }
  );

  await collectNodesToProcess(node, [], 0, nodesToProcess);

  const totalNodes = nodesToProcess.length;
  console.log(`Found ${totalNodes} total nodes to process`);

  // Calculate number of chunks needed
  const totalChunks = Math.ceil(totalNodes / chunkSize);
  console.log(`Will process in ${totalChunks} chunks`);

  // Send update after node collection
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "in_progress",
    5, // 5% progress for collection phase
    totalNodes,
    0,
    `Found ${totalNodes} nodes to scan. Will process in ${totalChunks} chunks.`,
    {
      totalNodes,
      totalChunks,
      chunkSize,
    }
  );

  // Process nodes in chunks
  const allTextNodes = [];
  let processedNodes = 0;
  let chunksProcessed = 0;

  for (let i = 0; i < totalNodes; i += chunkSize) {
    const chunkEnd = Math.min(i + chunkSize, totalNodes);
    console.log(
      `Processing chunk ${chunksProcessed + 1}/${totalChunks} (nodes ${i} to ${chunkEnd - 1
      })`
    );

    // Send update before processing chunk
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90), // 5-95% for processing
      totalNodes,
      processedNodes,
      `Processing chunk ${chunksProcessed + 1}/${totalChunks}`,
      {
        currentChunk: chunksProcessed + 1,
        totalChunks,
        textNodesFound: allTextNodes.length,
      }
    );

    const chunkNodes = nodesToProcess.slice(i, chunkEnd);
    const chunkTextNodes = [];

    // Process each node in this chunk
    for (const nodeInfo of chunkNodes) {
      if (nodeInfo.node.type === "TEXT") {
        try {
          const textNodeInfo = await processTextNode(
            nodeInfo.node,
            nodeInfo.parentPath,
            nodeInfo.depth
          );
          if (textNodeInfo) {
            chunkTextNodes.push(textNodeInfo);
          }
        } catch (error) {
          console.error(`Error processing text node: ${error.message}`);
          // Continue with other nodes
        }
      }

      // Brief delay to allow UI updates and prevent freezing
      await delay(5);
    }

    // Add results from this chunk
    allTextNodes.push(...chunkTextNodes);
    processedNodes += chunkNodes.length;
    chunksProcessed++;

    // Send update after processing chunk
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90), // 5-95% for processing
      totalNodes,
      processedNodes,
      `Processed chunk ${chunksProcessed}/${totalChunks}. Found ${allTextNodes.length} text nodes so far.`,
      {
        currentChunk: chunksProcessed,
        totalChunks,
        processedNodes,
        textNodesFound: allTextNodes.length,
        chunkResult: chunkTextNodes,
      }
    );

    // Small delay between chunks to prevent UI freezing
    if (i + chunkSize < totalNodes) {
      await delay(50);
    }
  }

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "completed",
    100,
    totalNodes,
    processedNodes,
    `Scan complete. Found ${allTextNodes.length} text nodes.`,
    {
      textNodes: allTextNodes,
      processedNodes,
      chunks: chunksProcessed,
    }
  );

  return {
    success: true,
    message: `Chunked scan complete. Found ${allTextNodes.length} text nodes.`,
    totalNodes: allTextNodes.length,
    processedNodes: processedNodes,
    chunks: chunksProcessed,
    textNodes: allTextNodes,
    commandId,
  };
}

// Helper function to collect all nodes that need to be processed
async function collectNodesToProcess(
  node,
  parentPath = [],
  depth = 0,
  nodesToProcess = []
) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Get the path to this node
  const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];

  // Add this node to the processing list
  nodesToProcess.push({
    node: node,
    parentPath: nodePath,
    depth: depth,
  });

  // Recursively add children
  if ("children" in node) {
    for (const child of node.children) {
      await collectNodesToProcess(child, nodePath, depth + 1, nodesToProcess);
    }
  }
}

// Process a single text node
async function processTextNode(node, parentPath, depth) {
  if (node.type !== "TEXT") return null;

  try {
    // Safely extract font information
    let fontFamily = "";
    let fontStyle = "";

    if (node.fontName) {
      if (typeof node.fontName === "object") {
        if ("family" in node.fontName) fontFamily = node.fontName.family;
        if ("style" in node.fontName) fontStyle = node.fontName.style;
      }
    }

    // Create a safe representation of the text node
    const safeTextNode = {
      id: node.id,
      name: node.name || "Text",
      type: node.type,
      characters: node.characters,
      fontSize: typeof node.fontSize === "number" ? node.fontSize : 0,
      fontFamily: fontFamily,
      fontStyle: fontStyle,
      x: typeof node.x === "number" ? node.x : 0,
      y: typeof node.y === "number" ? node.y : 0,
      width: typeof node.width === "number" ? node.width : 0,
      height: typeof node.height === "number" ? node.height : 0,
      path: parentPath.join(" > "),
      depth: depth,
    };

    // Highlight the node briefly (optional visual feedback)
    try {
      const originalFills = JSON.parse(JSON.stringify(node.fills));
      node.fills = [
        {
          type: "SOLID",
          color: { r: 1, g: 0.5, b: 0 },
          opacity: 0.3,
        },
      ];

      // Brief delay for the highlight to be visible
      await delay(100);

      try {
        node.fills = originalFills;
      } catch (err) {
        console.error("Error resetting fills:", err);
      }
    } catch (highlightErr) {
      console.error("Error highlighting text node:", highlightErr);
      // Continue anyway, highlighting is just visual feedback
    }

    return safeTextNode;
  } catch (nodeErr) {
    console.error("Error processing text node:", nodeErr);
    return null;
  }
}

// A delay function that returns a promise
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keep the original findTextNodes for backward compatibility
async function findTextNodes(node, parentPath = [], depth = 0, textNodes = []) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Get the path to this node including its name
  const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];

  if (node.type === "TEXT") {
    try {
      // Safely extract font information to avoid Symbol serialization issues
      let fontFamily = "";
      let fontStyle = "";

      if (node.fontName) {
        if (typeof node.fontName === "object") {
          if ("family" in node.fontName) fontFamily = node.fontName.family;
          if ("style" in node.fontName) fontStyle = node.fontName.style;
        }
      }

      // Create a safe representation of the text node with only serializable properties
      const safeTextNode = {
        id: node.id,
        name: node.name || "Text",
        type: node.type,
        characters: node.characters,
        fontSize: typeof node.fontSize === "number" ? node.fontSize : 0,
        fontFamily: fontFamily,
        fontStyle: fontStyle,
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
        path: nodePath.join(" > "),
        depth: depth,
      };

      // Only highlight the node if it's not being done via API
      try {
        // Safe way to create a temporary highlight without causing serialization issues
        const originalFills = JSON.parse(JSON.stringify(node.fills));
        node.fills = [
          {
            type: "SOLID",
            color: { r: 1, g: 0.5, b: 0 },
            opacity: 0.3,
          },
        ];

        // Promise-based delay instead of setTimeout
        await delay(500);

        try {
          node.fills = originalFills;
        } catch (err) {
          console.error("Error resetting fills:", err);
        }
      } catch (highlightErr) {
        console.error("Error highlighting text node:", highlightErr);
        // Continue anyway, highlighting is just visual feedback
      }

      textNodes.push(safeTextNode);
    } catch (nodeErr) {
      console.error("Error processing text node:", nodeErr);
      // Skip this node but continue with others
    }
  }

  // Recursively process children of container nodes
  if ("children" in node) {
    for (const child of node.children) {
      await findTextNodes(child, nodePath, depth + 1, textNodes);
    }
  }
}

// Replace text in a specific node
async function setMultipleTextContents(params) {
  const { nodeId, text } = params || {};
  const commandId = params.commandId || generateCommandId();

  if (!nodeId || !text || !Array.isArray(text)) {
    const errorMsg = "Missing required parameters: nodeId and text array";

    // Send error progress update
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "error",
      0,
      0,
      0,
      errorMsg,
      { error: errorMsg }
    );

    throw new Error(errorMsg);
  }

  console.log(
    `Starting text replacement for node: ${nodeId} with ${text.length} text replacements`
  );

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "started",
    0,
    text.length,
    0,
    `Starting text replacement for ${text.length} nodes`,
    { totalReplacements: text.length }
  );

  // Define the results array and counters
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Split text replacements into chunks of 5
  const CHUNK_SIZE = 5;
  const chunks = [];

  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }

  console.log(`Split ${text.length} replacements into ${chunks.length} chunks`);

  // Send chunking info update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "in_progress",
    5, // 5% progress for planning phase
    text.length,
    0,
    `Preparing to replace text in ${text.length} nodes using ${chunks.length} chunks`,
    {
      totalReplacements: text.length,
      chunks: chunks.length,
      chunkSize: CHUNK_SIZE,
    }
  );

  // Process each chunk sequentially
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    console.log(
      `Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length
      } replacements`
    );

    // Send chunk processing start update
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "in_progress",
      Math.round(5 + (chunkIndex / chunks.length) * 90), // 5-95% for processing
      text.length,
      successCount + failureCount,
      `Processing text replacements chunk ${chunkIndex + 1}/${chunks.length}`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
      }
    );

    // Process replacements within a chunk in parallel
    const chunkPromises = chunk.map(async (replacement) => {
      if (!replacement.nodeId || replacement.text === undefined) {
        console.error(`Missing nodeId or text for replacement`);
        return {
          success: false,
          nodeId: replacement.nodeId || "unknown",
          error: "Missing nodeId or text in replacement entry",
        };
      }

      try {
        console.log(
          `Attempting to replace text in node: ${replacement.nodeId}`
        );

        // Get the text node to update (just to check it exists and get original text)
        const textNode = await figma.getNodeByIdAsync(replacement.nodeId);

        if (!textNode) {
          console.error(`Text node not found: ${replacement.nodeId}`);
          return {
            success: false,
            nodeId: replacement.nodeId,
            error: `Node not found: ${replacement.nodeId}`,
          };
        }

        if (textNode.type !== "TEXT") {
          console.error(
            `Node is not a text node: ${replacement.nodeId} (type: ${textNode.type})`
          );
          return {
            success: false,
            nodeId: replacement.nodeId,
            error: `Node is not a text node: ${replacement.nodeId} (type: ${textNode.type})`,
          };
        }

        // Save original text for the result
        const originalText = textNode.characters;
        console.log(`Original text: "${originalText}"`);
        console.log(`Will translate to: "${replacement.text}"`);

        // Highlight the node before changing text
        let originalFills;
        try {
          // Save original fills for restoration later
          originalFills = JSON.parse(JSON.stringify(textNode.fills));
          // Apply highlight color (orange with 30% opacity)
          textNode.fills = [
            {
              type: "SOLID",
              color: { r: 1, g: 0.5, b: 0 },
              opacity: 0.3,
            },
          ];
        } catch (highlightErr) {
          console.error(
            `Error highlighting text node: ${highlightErr.message}`
          );
          // Continue anyway, highlighting is just visual feedback
        }

        // Use the existing setTextContent function to handle font loading and text setting
        await setTextContent({
          nodeId: replacement.nodeId,
          text: replacement.text,
        });

        // Keep highlight for a moment after text change, then restore original fills
        if (originalFills) {
          try {
            // Use delay function for consistent timing
            await delay(500);
            textNode.fills = originalFills;
          } catch (restoreErr) {
            console.error(`Error restoring fills: ${restoreErr.message}`);
          }
        }

        console.log(
          `Successfully replaced text in node: ${replacement.nodeId}`
        );
        return {
          success: true,
          nodeId: replacement.nodeId,
          originalText: originalText,
          translatedText: replacement.text,
        };
      } catch (error) {
        console.error(
          `Error replacing text in node ${replacement.nodeId}: ${error.message}`
        );
        return {
          success: false,
          nodeId: replacement.nodeId,
          error: `Error applying replacement: ${error.message}`,
        };
      }
    });

    // Wait for all replacements in this chunk to complete
    const chunkResults = await Promise.all(chunkPromises);

    // Process results for this chunk
    chunkResults.forEach((result) => {
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
      results.push(result);
    });

    // Send chunk processing complete update with partial results
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "in_progress",
      Math.round(5 + ((chunkIndex + 1) / chunks.length) * 90), // 5-95% for processing
      text.length,
      successCount + failureCount,
      `Completed chunk ${chunkIndex + 1}/${chunks.length
      }. ${successCount} successful, ${failureCount} failed so far.`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
        chunkResults: chunkResults,
      }
    );

    // Add a small delay between chunks to avoid overloading Figma
    if (chunkIndex < chunks.length - 1) {
      console.log("Pausing between chunks to avoid overloading Figma...");
      await delay(1000); // 1 second delay between chunks
    }
  }

  console.log(
    `Replacement complete: ${successCount} successful, ${failureCount} failed`
  );

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "completed",
    100,
    text.length,
    successCount + failureCount,
    `Text replacement complete: ${successCount} successful, ${failureCount} failed`,
    {
      totalReplacements: text.length,
      replacementsApplied: successCount,
      replacementsFailed: failureCount,
      completedInChunks: chunks.length,
      results: results,
    }
  );

  return {
    success: successCount > 0,
    nodeId: nodeId,
    replacementsApplied: successCount,
    replacementsFailed: failureCount,
    totalReplacements: text.length,
    results: results,
    completedInChunks: chunks.length,
    commandId,
  };
}

// Function to generate simple UUIDs for command IDs
function generateCommandId() {
  return (
    "cmd_" +
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

async function getAnnotations(params) {
  try {
    const { nodeId, includeCategories = true } = params;

    // Get categories first if needed
    let categoriesMap = {};
    if (includeCategories) {
      const categories = await figma.annotations.getAnnotationCategoriesAsync();
      categoriesMap = categories.reduce((map, category) => {
        map[category.id] = {
          id: category.id,
          label: category.label,
          color: category.color,
          isPreset: category.isPreset,
        };
        return map;
      }, {});
    }

    if (nodeId) {
      // Get annotations for a specific node
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      if (!("annotations" in node)) {
        throw new Error(`Node type ${node.type} does not support annotations`);
      }

      // Collect annotations from this node and all its descendants
      const mergedAnnotations = [];
      const collect = async (n) => {
        if ("annotations" in n && n.annotations && n.annotations.length > 0) {
          for (const a of n.annotations) {
            mergedAnnotations.push({ nodeId: n.id, annotation: a });
          }
        }
        if ("children" in n) {
          for (const child of n.children) {
            await collect(child);
          }
        }
      };
      await collect(node);

      const result = {
        nodeId: node.id,
        name: node.name,
        annotations: mergedAnnotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    } else {
      // Get all annotations in the current page
      const annotations = [];
      const processNode = async (node) => {
        if (
          "annotations" in node &&
          node.annotations &&
          node.annotations.length > 0
        ) {
          annotations.push({
            nodeId: node.id,
            name: node.name,
            annotations: node.annotations,
          });
        }
        if ("children" in node) {
          for (const child of node.children) {
            await processNode(child);
          }
        }
      };

      // Start from current page
      await processNode(figma.currentPage);

      const result = {
        annotatedNodes: annotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    }
  } catch (error) {
    console.error("Error in getAnnotations:", error);
    throw error;
  }
}

async function setAnnotation(params) {
  try {
    console.log("=== setAnnotation Debug Start ===");
    console.log("Input params:", JSON.stringify(params, null, 2));

    const { nodeId, annotationId, labelMarkdown, categoryId, properties } =
      params;

    // Validate required parameters
    if (!nodeId) {
      console.error("Validation failed: Missing nodeId");
      return { success: false, error: "Missing nodeId" };
    }

    if (!labelMarkdown) {
      console.error("Validation failed: Missing labelMarkdown");
      return { success: false, error: "Missing labelMarkdown" };
    }

    console.log("Attempting to get node:", nodeId);
    // Get and validate node
    const node = await figma.getNodeByIdAsync(nodeId);
    console.log("Node lookup result:", {
      id: nodeId,
      found: !!node,
      type: node ? node.type : undefined,
      name: node ? node.name : undefined,
      hasAnnotations: node ? "annotations" in node : false,
    });

    if (!node) {
      console.error("Node lookup failed:", nodeId);
      return { success: false, error: `Node not found: ${nodeId}` };
    }

    // Validate node supports annotations
    if (!("annotations" in node)) {
      console.error("Node annotation support check failed:", {
        nodeType: node.type,
        nodeId: node.id,
      });
      return {
        success: false,
        error: `Node type ${node.type} does not support annotations`,
      };
    }

    // Create the annotation object
    const newAnnotation = {
      labelMarkdown,
    };

    // Validate and add categoryId if provided
    if (categoryId) {
      console.log("Adding categoryId to annotation:", categoryId);
      newAnnotation.categoryId = categoryId;
    }

    // Validate and add properties if provided
    if (properties && Array.isArray(properties) && properties.length > 0) {
      console.log(
        "Adding properties to annotation:",
        JSON.stringify(properties, null, 2)
      );
      newAnnotation.properties = properties;
    }

    // Log current annotations before update
    console.log("Current node annotations:", node.annotations);

    // Overwrite annotations
    console.log(
      "Setting new annotation:",
      JSON.stringify(newAnnotation, null, 2)
    );
    node.annotations = [newAnnotation];

    // Verify the update
    console.log("Updated node annotations:", node.annotations);
    console.log("=== setAnnotation Debug End ===");

    return {
      success: true,
      nodeId: node.id,
      name: node.name,
      annotations: node.annotations,
    };
  } catch (error) {
    console.error("=== setAnnotation Error ===");
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      params: JSON.stringify(params, null, 2),
    });
    return { success: false, error: error.message };
  }
}

/**
 * Scan for nodes with specific types within a node
 * @param {Object} params - Parameters object
 * @param {string} params.nodeId - ID of the node to scan within
 * @param {Array<string>} params.types - Array of node types to find (e.g. ['COMPONENT', 'FRAME'])
 * @returns {Object} - Object containing found nodes
 */
async function scanNodesByTypes(params) {
  console.log(`Starting to scan nodes by types from node ID: ${params.nodeId}`);
  const { nodeId, types = [] } = params || {};

  if (!types || types.length === 0) {
    throw new Error("No types specified to search for");
  }

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Simple implementation without chunking
  const matchingNodes = [];

  // Send a single progress update to notify start
  const commandId = generateCommandId();
  sendProgressUpdate(
    commandId,
    "scan_nodes_by_types",
    "started",
    0,
    1,
    0,
    `Starting scan of node "${node.name || nodeId}" for types: ${types.join(
      ", "
    )}`,
    null
  );

  // Recursively find nodes with specified types
  await findNodesByTypes(node, types, matchingNodes);

  // Send completion update
  sendProgressUpdate(
    commandId,
    "scan_nodes_by_types",
    "completed",
    100,
    matchingNodes.length,
    matchingNodes.length,
    `Scan complete. Found ${matchingNodes.length} matching nodes.`,
    { matchingNodes }
  );

  return {
    success: true,
    message: `Found ${matchingNodes.length} matching nodes.`,
    count: matchingNodes.length,
    matchingNodes: matchingNodes,
    searchedTypes: types,
  };
}

/**
 * Helper function to recursively find nodes with specific types
 * @param {SceneNode} node - The root node to start searching from
 * @param {Array<string>} types - Array of node types to find
 * @param {Array} matchingNodes - Array to store found nodes
 */
async function findNodesByTypes(node, types, matchingNodes = []) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Check if this node is one of the specified types
  if (types.includes(node.type)) {
    // Create a minimal representation with just ID, type and bbox
    matchingNodes.push({
      id: node.id,
      name: node.name || `Unnamed ${node.type}`,
      type: node.type,
      // Basic bounding box info
      bbox: {
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
      },
    });
  }

  // Recursively process children of container nodes
  if ("children" in node) {
    for (const child of node.children) {
      await findNodesByTypes(child, types, matchingNodes);
    }
  }
}

// Set multiple annotations with async progress updates
async function setMultipleAnnotations(params) {
  console.log("=== setMultipleAnnotations Debug Start ===");
  console.log("Input params:", JSON.stringify(params, null, 2));

  const { nodeId, annotations } = params;

  if (!annotations || annotations.length === 0) {
    console.error("Validation failed: No annotations provided");
    return { success: false, error: "No annotations provided" };
  }

  console.log(
    `Processing ${annotations.length} annotations for node ${nodeId}`
  );

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Process annotations sequentially
  for (let i = 0; i < annotations.length; i++) {
    const annotation = annotations[i];
    console.log(
      `\nProcessing annotation ${i + 1}/${annotations.length}:`,
      JSON.stringify(annotation, null, 2)
    );

    try {
      console.log("Calling setAnnotation with params:", {
        nodeId: annotation.nodeId,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      const result = await setAnnotation({
        nodeId: annotation.nodeId,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      console.log("setAnnotation result:", JSON.stringify(result, null, 2));

      if (result.success) {
        successCount++;
        results.push({ success: true, nodeId: annotation.nodeId });
        console.log(`✓ Annotation ${i + 1} applied successfully`);
      } else {
        failureCount++;
        results.push({
          success: false,
          nodeId: annotation.nodeId,
          error: result.error,
        });
        console.error(`✗ Annotation ${i + 1} failed:`, result.error);
      }
    } catch (error) {
      failureCount++;
      const errorResult = {
        success: false,
        nodeId: annotation.nodeId,
        error: error.message,
      };
      results.push(errorResult);
      console.error(`✗ Annotation ${i + 1} failed with error:`, error);
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
      });
    }
  }

  const summary = {
    success: successCount > 0,
    annotationsApplied: successCount,
    annotationsFailed: failureCount,
    totalAnnotations: annotations.length,
    results: results,
  };

  console.log("\n=== setMultipleAnnotations Summary ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("=== setMultipleAnnotations Debug End ===");

  return summary;
}

async function deleteMultipleNodes(params) {
  const { nodeIds } = params || {};
  const commandId = generateCommandId();

  if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0) {
    const errorMsg = "Missing or invalid nodeIds parameter";
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "error",
      0,
      0,
      0,
      errorMsg,
      { error: errorMsg }
    );
    throw new Error(errorMsg);
  }

  console.log(`Starting deletion of ${nodeIds.length} nodes`);

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "started",
    0,
    nodeIds.length,
    0,
    `Starting deletion of ${nodeIds.length} nodes`,
    { totalNodes: nodeIds.length }
  );

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Process nodes in chunks of 5 to avoid overwhelming Figma
  const CHUNK_SIZE = 5;
  const chunks = [];

  for (let i = 0; i < nodeIds.length; i += CHUNK_SIZE) {
    chunks.push(nodeIds.slice(i, i + CHUNK_SIZE));
  }

  console.log(`Split ${nodeIds.length} deletions into ${chunks.length} chunks`);

  // Send chunking info update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "in_progress",
    5,
    nodeIds.length,
    0,
    `Preparing to delete ${nodeIds.length} nodes using ${chunks.length} chunks`,
    {
      totalNodes: nodeIds.length,
      chunks: chunks.length,
      chunkSize: CHUNK_SIZE,
    }
  );

  // Process each chunk sequentially
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    console.log(
      `Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length
      } nodes`
    );

    // Send chunk processing start update
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "in_progress",
      Math.round(5 + (chunkIndex / chunks.length) * 90),
      nodeIds.length,
      successCount + failureCount,
      `Processing deletion chunk ${chunkIndex + 1}/${chunks.length}`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
      }
    );

    // Process deletions within a chunk in parallel
    const chunkPromises = chunk.map(async (nodeId) => {
      try {
        const node = await figma.getNodeByIdAsync(nodeId);

        if (!node) {
          console.error(`Node not found: ${nodeId}`);
          return {
            success: false,
            nodeId: nodeId,
            error: `Node not found: ${nodeId}`,
          };
        }

        // Save node info before deleting
        const nodeInfo = {
          id: node.id,
          name: node.name,
          type: node.type,
        };

        // Delete the node
        node.remove();

        console.log(`Successfully deleted node: ${nodeId}`);
        return {
          success: true,
          nodeId: nodeId,
          nodeInfo: nodeInfo,
        };
      } catch (error) {
        console.error(`Error deleting node ${nodeId}: ${error.message}`);
        return {
          success: false,
          nodeId: nodeId,
          error: error.message,
        };
      }
    });

    // Wait for all deletions in this chunk to complete
    const chunkResults = await Promise.all(chunkPromises);

    // Process results for this chunk
    chunkResults.forEach((result) => {
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
      results.push(result);
    });

    // Send chunk processing complete update
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "in_progress",
      Math.round(5 + ((chunkIndex + 1) / chunks.length) * 90),
      nodeIds.length,
      successCount + failureCount,
      `Completed chunk ${chunkIndex + 1}/${chunks.length
      }. ${successCount} successful, ${failureCount} failed so far.`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
        chunkResults: chunkResults,
      }
    );

    // Add a small delay between chunks
    if (chunkIndex < chunks.length - 1) {
      console.log("Pausing between chunks...");
      await delay(1000);
    }
  }

  console.log(
    `Deletion complete: ${successCount} successful, ${failureCount} failed`
  );

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "completed",
    100,
    nodeIds.length,
    successCount + failureCount,
    `Node deletion complete: ${successCount} successful, ${failureCount} failed`,
    {
      totalNodes: nodeIds.length,
      nodesDeleted: successCount,
      nodesFailed: failureCount,
      completedInChunks: chunks.length,
      results: results,
    }
  );

  return {
    success: successCount > 0,
    nodesDeleted: successCount,
    nodesFailed: failureCount,
    totalNodes: nodeIds.length,
    results: results,
    completedInChunks: chunks.length,
    commandId,
  };
}

// Implementation for getInstanceOverrides function
async function getInstanceOverrides(instanceNode = null) {
  console.log("=== getInstanceOverrides called ===");

  let sourceInstance = null;

  // Check if an instance node was passed directly
  if (instanceNode) {
    console.log("Using provided instance node");

    // Validate that the provided node is an instance
    if (instanceNode.type !== "INSTANCE") {
      console.error("Provided node is not an instance");
      figma.notify("Provided node is not a component instance");
      return { success: false, message: "Provided node is not a component instance" };
    }

    sourceInstance = instanceNode;
  } else {
    // No node provided, use selection
    console.log("No node provided, using current selection");

    // Get the current selection
    const selection = figma.currentPage.selection;

    // Check if there's anything selected
    if (selection.length === 0) {
      console.log("No nodes selected");
      figma.notify("Please select at least one instance");
      return { success: false, message: "No nodes selected" };
    }

    // Filter for instances in the selection
    const instances = selection.filter(node => node.type === "INSTANCE");

    if (instances.length === 0) {
      console.log("No instances found in selection");
      figma.notify("Please select at least one component instance");
      return { success: false, message: "No instances found in selection" };
    }

    // Take the first instance from the selection
    sourceInstance = instances[0];
  }

  try {
    console.log(`Getting instance information:`);
    console.log(sourceInstance);

    // Get component overrides and main component
    const overrides = sourceInstance.overrides || [];
    console.log(`  Raw Overrides:`, overrides);

    // Get main component
    const mainComponent = await sourceInstance.getMainComponentAsync();
    if (!mainComponent) {
      console.error("Failed to get main component");
      figma.notify("Failed to get main component");
      return { success: false, message: "Failed to get main component" };
    }

    // return data to MCP server
    const returnData = {
      success: true,
      message: `Got component information from "${sourceInstance.name}" for overrides.length: ${overrides.length}`,
      sourceInstanceId: sourceInstance.id,
      mainComponentId: mainComponent.id,
      overridesCount: overrides.length
    };

    console.log("Data to return to MCP server:", returnData);
    figma.notify(`Got component information from "${sourceInstance.name}"`);

    return returnData;
  } catch (error) {
    console.error("Error in getInstanceOverrides:", error);
    figma.notify(`Error: ${error.message}`);
    return {
      success: false,
      message: `Error: ${error.message}`
    };
  }
}

/**
 * Helper function to validate and get target instances
 * @param {string[]} targetNodeIds - Array of instance node IDs
 * @returns {instanceNode[]} targetInstances - Array of target instances
 */
async function getValidTargetInstances(targetNodeIds) {
  let targetInstances = [];

  // Handle array of instances or single instance
  if (Array.isArray(targetNodeIds)) {
    if (targetNodeIds.length === 0) {
      return { success: false, message: "No instances provided" };
    }
    for (const targetNodeId of targetNodeIds) {
      const targetNode = await figma.getNodeByIdAsync(targetNodeId);
      if (targetNode && targetNode.type === "INSTANCE") {
        targetInstances.push(targetNode);
      }
    }
    if (targetInstances.length === 0) {
      return { success: false, message: "No valid instances provided" };
    }
  } else {
    return { success: false, message: "Invalid target node IDs provided" };
  }


  return { success: true, message: "Valid target instances provided", targetInstances };
}

/**
 * Helper function to validate and get saved override data
 * @param {string} sourceInstanceId - Source instance ID
 * @returns {Promise<Object>} - Validation result with source instance data or error
 */
async function getSourceInstanceData(sourceInstanceId) {
  if (!sourceInstanceId) {
    return { success: false, message: "Missing source instance ID" };
  }

  // Get source instance by ID
  const sourceInstance = await figma.getNodeByIdAsync(sourceInstanceId);
  if (!sourceInstance) {
    return {
      success: false,
      message: "Source instance not found. The original instance may have been deleted."
    };
  }

  // Verify it's an instance
  if (sourceInstance.type !== "INSTANCE") {
    return {
      success: false,
      message: "Source node is not a component instance."
    };
  }

  // Get main component
  const mainComponent = await sourceInstance.getMainComponentAsync();
  if (!mainComponent) {
    return {
      success: false,
      message: "Failed to get main component from source instance."
    };
  }

  return {
    success: true,
    sourceInstance,
    mainComponent,
    overrides: sourceInstance.overrides || []
  };
}

/**
 * Sets saved overrides to the selected component instance(s)
 * @param {InstanceNode[] | null} targetInstances - Array of instance nodes to set overrides to
 * @param {Object} sourceResult - Source instance data from getSourceInstanceData
 * @returns {Promise<Object>} - Result of the set operation
 */
async function setInstanceOverrides(targetInstances, sourceResult) {
  try {


    const { sourceInstance, mainComponent, overrides } = sourceResult;

    console.log(`Processing ${targetInstances.length} instances with ${overrides.length} overrides`);
    console.log(`Source instance: ${sourceInstance.id}, Main component: ${mainComponent.id}`);
    console.log(`Overrides:`, overrides);

    // Process all instances
    const results = [];
    let totalAppliedCount = 0;

    for (const targetInstance of targetInstances) {
      try {
        // // Skip if trying to apply to the source instance itself
        // if (targetInstance.id === sourceInstance.id) {
        //   console.log(`Skipping source instance itself: ${targetInstance.id}`);
        //   results.push({
        //     success: false,
        //     instanceId: targetInstance.id,
        //     instanceName: targetInstance.name,
        //     message: "This is the source instance itself, skipping"
        //   });
        //   continue;
        // }

        // Swap component
        try {
          targetInstance.swapComponent(mainComponent);
          console.log(`Swapped component for instance "${targetInstance.name}"`);
        } catch (error) {
          console.error(`Error swapping component for instance "${targetInstance.name}":`, error);
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: `Error: ${error.message}`
          });
        }

        // Prepare overrides by replacing node IDs
        let appliedCount = 0;

        // Apply each override
        for (const override of overrides) {
          // Skip if no ID or overriddenFields
          if (!override.id || !override.overriddenFields || override.overriddenFields.length === 0) {
            continue;
          }

          // Replace source instance ID with target instance ID in the node path
          const overrideNodeId = override.id.replace(sourceInstance.id, targetInstance.id);
          const overrideNode = await figma.getNodeByIdAsync(overrideNodeId);

          if (!overrideNode) {
            console.log(`Override node not found: ${overrideNodeId}`);
            continue;
          }

          // Get source node to copy properties from
          const sourceNode = await figma.getNodeByIdAsync(override.id);
          if (!sourceNode) {
            console.log(`Source node not found: ${override.id}`);
            continue;
          }

          // Apply each overridden field
          let fieldApplied = false;
          for (const field of override.overriddenFields) {
            try {
              if (field === "componentProperties") {
                // Apply component properties
                if (sourceNode.componentProperties && overrideNode.componentProperties) {
                  const properties = {};
                  for (const key in sourceNode.componentProperties) {
                    // if INSTANCE_SWAP use id, otherwise use value
                    if (sourceNode.componentProperties[key].type === 'INSTANCE_SWAP') {
                      properties[key] = sourceNode.componentProperties[key].value;
                    
                    } else {
                      properties[key] = sourceNode.componentProperties[key].value;
                    }
                  }
                  overrideNode.setProperties(properties);
                  fieldApplied = true;
                }
              } else if (field === "characters" && overrideNode.type === "TEXT") {
                // For text nodes, need to load fonts first
                await figma.loadFontAsync(overrideNode.fontName);
                overrideNode.characters = sourceNode.characters;
                fieldApplied = true;
              } else if (field in overrideNode) {
                // Direct property assignment
                overrideNode[field] = sourceNode[field];
                fieldApplied = true;
              }
            } catch (fieldError) {
              console.error(`Error applying field ${field}:`, fieldError);
            }
          }

          if (fieldApplied) {
            appliedCount++;
          }
        }

        if (appliedCount > 0) {
          totalAppliedCount += appliedCount;
          results.push({
            success: true,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            appliedCount
          });
          console.log(`Applied ${appliedCount} overrides to "${targetInstance.name}"`);
        } else {
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: "No overrides were applied"
          });
        }
      } catch (instanceError) {
        console.error(`Error processing instance "${targetInstance.name}":`, instanceError);
        results.push({
          success: false,
          instanceId: targetInstance.id,
          instanceName: targetInstance.name,
          message: `Error: ${instanceError.message}`
        });
      }
    }

    // Return results
    if (totalAppliedCount > 0) {
      const instanceCount = results.filter(r => r.success).length;
      const message = `Applied ${totalAppliedCount} overrides to ${instanceCount} instances`;
      figma.notify(message);
      return {
        success: true,
        message,
        totalCount: totalAppliedCount,
        results
      };
    } else {
      const message = "No overrides applied to any instance";
      figma.notify(message);
      return { success: false, message, results };
    }

  } catch (error) {
    console.error("Error in setInstanceOverrides:", error);
    const message = `Error: ${error.message}`;
    figma.notify(message);
    return { success: false, message };
  }
}

async function setLayoutMode(params) {
  const { nodeId, layoutMode = "NONE", layoutWrap = "NO_WRAP" } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports layoutMode
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support layoutMode`);
  }

  // Set layout mode
  node.layoutMode = layoutMode;

  // Set layoutWrap if applicable
  if (layoutMode !== "NONE") {
    node.layoutWrap = layoutWrap;
  }

  return {
    id: node.id,
    name: node.name,
    layoutMode: node.layoutMode,
    layoutWrap: node.layoutWrap,
  };
}

async function setPadding(params) {
  const { nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft } =
    params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports padding
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support padding`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Padding can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Set padding values if provided
  if (paddingTop !== undefined) node.paddingTop = paddingTop;
  if (paddingRight !== undefined) node.paddingRight = paddingRight;
  if (paddingBottom !== undefined) node.paddingBottom = paddingBottom;
  if (paddingLeft !== undefined) node.paddingLeft = paddingLeft;

  return {
    id: node.id,
    name: node.name,
    paddingTop: node.paddingTop,
    paddingRight: node.paddingRight,
    paddingBottom: node.paddingBottom,
    paddingLeft: node.paddingLeft,
  };
}

async function setAxisAlign(params) {
  const { nodeId, primaryAxisAlignItems, counterAxisAlignItems } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports axis alignment
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support axis alignment`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Axis alignment can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Validate and set primaryAxisAlignItems if provided
  if (primaryAxisAlignItems !== undefined) {
    if (
      !["MIN", "MAX", "CENTER", "SPACE_BETWEEN"].includes(primaryAxisAlignItems)
    ) {
      throw new Error(
        "Invalid primaryAxisAlignItems value. Must be one of: MIN, MAX, CENTER, SPACE_BETWEEN"
      );
    }
    node.primaryAxisAlignItems = primaryAxisAlignItems;
  }

  // Validate and set counterAxisAlignItems if provided
  if (counterAxisAlignItems !== undefined) {
    if (!["MIN", "MAX", "CENTER", "BASELINE"].includes(counterAxisAlignItems)) {
      throw new Error(
        "Invalid counterAxisAlignItems value. Must be one of: MIN, MAX, CENTER, BASELINE"
      );
    }
    // BASELINE is only valid for horizontal layout
    if (
      counterAxisAlignItems === "BASELINE" &&
      node.layoutMode !== "HORIZONTAL"
    ) {
      throw new Error(
        "BASELINE alignment is only valid for horizontal auto-layout frames"
      );
    }
    node.counterAxisAlignItems = counterAxisAlignItems;
  }

  return {
    id: node.id,
    name: node.name,
    primaryAxisAlignItems: node.primaryAxisAlignItems,
    counterAxisAlignItems: node.counterAxisAlignItems,
    layoutMode: node.layoutMode,
  };
}

async function setLayoutSizing(params) {
  const { nodeId, layoutSizingHorizontal, layoutSizingVertical } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports layout sizing
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support layout sizing`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Layout sizing can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Validate and set layoutSizingHorizontal if provided
  if (layoutSizingHorizontal !== undefined) {
    if (!["FIXED", "HUG", "FILL"].includes(layoutSizingHorizontal)) {
      throw new Error(
        "Invalid layoutSizingHorizontal value. Must be one of: FIXED, HUG, FILL"
      );
    }
    // HUG is only valid on auto-layout frames and text nodes
    if (
      layoutSizingHorizontal === "HUG" &&
      !["FRAME", "TEXT"].includes(node.type)
    ) {
      throw new Error(
        "HUG sizing is only valid on auto-layout frames and text nodes"
      );
    }
    // FILL is only valid on auto-layout children
    if (
      layoutSizingHorizontal === "FILL" &&
      (!node.parent || node.parent.layoutMode === "NONE")
    ) {
      throw new Error("FILL sizing is only valid on auto-layout children");
    }
    node.layoutSizingHorizontal = layoutSizingHorizontal;
  }

  // Validate and set layoutSizingVertical if provided
  if (layoutSizingVertical !== undefined) {
    if (!["FIXED", "HUG", "FILL"].includes(layoutSizingVertical)) {
      throw new Error(
        "Invalid layoutSizingVertical value. Must be one of: FIXED, HUG, FILL"
      );
    }
    // HUG is only valid on auto-layout frames and text nodes
    if (
      layoutSizingVertical === "HUG" &&
      !["FRAME", "TEXT"].includes(node.type)
    ) {
      throw new Error(
        "HUG sizing is only valid on auto-layout frames and text nodes"
      );
    }
    // FILL is only valid on auto-layout children
    if (
      layoutSizingVertical === "FILL" &&
      (!node.parent || node.parent.layoutMode === "NONE")
    ) {
      throw new Error("FILL sizing is only valid on auto-layout children");
    }
    node.layoutSizingVertical = layoutSizingVertical;
  }

  return {
    id: node.id,
    name: node.name,
    layoutSizingHorizontal: node.layoutSizingHorizontal,
    layoutSizingVertical: node.layoutSizingVertical,
    layoutMode: node.layoutMode,
  };
}

async function setItemSpacing(params) {
  const { nodeId, itemSpacing, counterAxisSpacing } = params || {};

  // Validate that at least one spacing parameter is provided
  if (itemSpacing === undefined && counterAxisSpacing === undefined) {
    throw new Error("At least one of itemSpacing or counterAxisSpacing must be provided");
  }

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports item spacing
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support item spacing`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Item spacing can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Set item spacing if provided
  if (itemSpacing !== undefined) {
    if (typeof itemSpacing !== "number") {
      throw new Error("Item spacing must be a number");
    }
    node.itemSpacing = itemSpacing;
  }

  // Set counter axis spacing if provided
  if (counterAxisSpacing !== undefined) {
    if (typeof counterAxisSpacing !== "number") {
      throw new Error("Counter axis spacing must be a number");
    }
    // counterAxisSpacing only applies when layoutWrap is WRAP
    if (node.layoutWrap !== "WRAP") {
      throw new Error(
        "Counter axis spacing can only be set on frames with layoutWrap set to WRAP"
      );
    }
    node.counterAxisSpacing = counterAxisSpacing;
  }

  return {
    id: node.id,
    name: node.name,
    itemSpacing: node.itemSpacing || undefined,
    counterAxisSpacing: node.counterAxisSpacing || undefined,
    layoutMode: node.layoutMode,
    layoutWrap: node.layoutWrap,
  };
}

async function setDefaultConnector(params) {
  const { connectorId } = params || {};
  
  // If connectorId is provided, search and set by that ID (do not check existing storage)
  if (connectorId) {
    // Get node by specified ID
    const node = await figma.getNodeByIdAsync(connectorId);
    if (!node) {
      throw new Error(`Connector node not found with ID: ${connectorId}`);
    }
    
    // Check node type
    if (node.type !== 'CONNECTOR') {
      throw new Error(`Node is not a connector: ${connectorId}`);
    }
    
    // Set the found connector as the default connector
    await figma.clientStorage.setAsync('defaultConnectorId', connectorId);
    
    return {
      success: true,
      message: `Default connector set to: ${connectorId}`,
      connectorId: connectorId
    };
  } 
  // If connectorId is not provided, check existing storage
  else {
    // Check if there is an existing default connector in client storage
    try {
      const existingConnectorId = await figma.clientStorage.getAsync('defaultConnectorId');
      
      // If there is an existing connector ID, check if the node is still valid
      if (existingConnectorId) {
        try {
          const existingConnector = await figma.getNodeByIdAsync(existingConnectorId);
          
          // If the stored connector still exists and is of type CONNECTOR
          if (existingConnector && existingConnector.type === 'CONNECTOR') {
            return {
              success: true,
              message: `Default connector is already set to: ${existingConnectorId}`,
              connectorId: existingConnectorId,
              exists: true
            };
          }
          // The stored connector is no longer valid - find a new connector
          else {
            console.log(`Stored connector ID ${existingConnectorId} is no longer valid, finding a new connector...`);
          }
        } catch (error) {
          console.log(`Error finding stored connector: ${error.message}. Will try to set a new one.`);
        }
      }
    } catch (error) {
      console.log(`Error checking for existing connector: ${error.message}`);
    }
    
    // If there is no stored default connector or it is invalid, find one in the current page
    try {
      // Find CONNECTOR type nodes in the current page
      const currentPageConnectors = figma.currentPage.findAllWithCriteria({ types: ['CONNECTOR'] });
      
      if (currentPageConnectors && currentPageConnectors.length > 0) {
        // Use the first connector found
        const foundConnector = currentPageConnectors[0];
        const autoFoundId = foundConnector.id;
        
        // Set the found connector as the default connector
        await figma.clientStorage.setAsync('defaultConnectorId', autoFoundId);
        
        return {
          success: true,
          message: `Automatically found and set default connector to: ${autoFoundId}`,
          connectorId: autoFoundId,
          autoSelected: true
        };
      } else {
        // If no connector is found in the current page, show a guide message
        throw new Error('No connector found in the current page. Please create a connector in Figma first or specify a connector ID.');
      }
    } catch (error) {
      // Error occurred while running findAllWithCriteria
      throw new Error(`Failed to find a connector: ${error.message}`);
    }
  }
}

async function createCursorNode(targetNodeId) {
  const svgString = `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 8V35.2419L22 28.4315L27 39.7823C27 39.7823 28.3526 40.2722 29 39.7823C29.6474 39.2924 30.2913 38.3057 30 37.5121C28.6247 33.7654 25 26.1613 25 26.1613H32L16 8Z" fill="#202125" />
  </svg>`;
  try {
    const targetNode = await figma.getNodeByIdAsync(targetNodeId);
    if (!targetNode) throw new Error("Target node not found");

    // The targetNodeId has semicolons since it is a nested node.
    // So we need to get the parent node ID from the target node ID and check if we can appendChild to it or not.
    let parentNodeId = targetNodeId.includes(';') 
      ? targetNodeId.split(';')[0] 
      : targetNodeId;
    if (!parentNodeId) throw new Error("Could not determine parent node ID");

    // Find the parent node to append cursor node as child
    let parentNode = await figma.getNodeByIdAsync(parentNodeId);
    if (!parentNode) throw new Error("Parent node not found");

    // If the parent node is not eligible to appendChild, set the parentNode to the parent of the parentNode
    if (parentNode.type === 'INSTANCE' || parentNode.type === 'COMPONENT' || parentNode.type === 'COMPONENT_SET') {
      parentNode = parentNode.parent;
      if (!parentNode) throw new Error("Parent node not found");
    }

    // Create the cursor node
    const importedNode = await figma.createNodeFromSvg(svgString);
    if (!importedNode || !importedNode.id) {
      throw new Error("Failed to create imported cursor node");
    }
    importedNode.name = "TTF_Connector / Mouse Cursor";
    importedNode.resize(48, 48);

    const cursorNode = importedNode.findOne(node => node.type === 'VECTOR');
    if (cursorNode) {
      cursorNode.fills = [{
        type: 'SOLID',
        color: { r: 0, g: 0, b: 0 },
        opacity: 1
      }];
      cursorNode.strokes = [{
        type: 'SOLID',
        color: { r: 1, g: 1, b: 1 },
        opacity: 1
      }];
      cursorNode.strokeWeight = 2;
      cursorNode.strokeAlign = 'OUTSIDE';
      cursorNode.effects = [{
        type: "DROP_SHADOW",
        color: { r: 0, g: 0, b: 0, a: 0.3 },
        offset: { x: 1, y: 1 },
        radius: 2,
        spread: 0,
        visible: true,
        blendMode: "NORMAL"
      }];
    }

    // Append the cursor node to the parent node
    parentNode.appendChild(importedNode);

    // if the parentNode has auto-layout enabled, set the layoutPositioning to ABSOLUTE
    if ('layoutMode' in parentNode && parentNode.layoutMode !== 'NONE') {
      importedNode.layoutPositioning = 'ABSOLUTE';
    }

    // Adjust the importedNode's position to the targetNode's position
    if (
      targetNode.absoluteBoundingBox &&
      parentNode.absoluteBoundingBox
    ) {
      // if the targetNode has absoluteBoundingBox, set the importedNode's absoluteBoundingBox to the targetNode's absoluteBoundingBox
      console.log('targetNode.absoluteBoundingBox', targetNode.absoluteBoundingBox);
      console.log('parentNode.absoluteBoundingBox', parentNode.absoluteBoundingBox);
      importedNode.x = targetNode.absoluteBoundingBox.x - parentNode.absoluteBoundingBox.x  + targetNode.absoluteBoundingBox.width / 2 - 48 / 2
      importedNode.y = targetNode.absoluteBoundingBox.y - parentNode.absoluteBoundingBox.y + targetNode.absoluteBoundingBox.height / 2 - 48 / 2;
    } else if (
      'x' in targetNode && 'y' in targetNode && 'width' in targetNode && 'height' in targetNode) {
        // if the targetNode has x, y, width, height, calculate center based on relative position
        console.log('targetNode.x/y/width/height', targetNode.x, targetNode.y, targetNode.width, targetNode.height);
        importedNode.x = targetNode.x + targetNode.width / 2 - 48 / 2;
        importedNode.y = targetNode.y + targetNode.height / 2 - 48 / 2;
    } else {
      // Fallback: Place at top-left of target if possible, otherwise at (0,0) relative to parent
      if ('x' in targetNode && 'y' in targetNode) {
        console.log('Fallback to targetNode x/y');
        importedNode.x = targetNode.x;
        importedNode.y = targetNode.y;
      } else {
        console.log('Fallback to (0,0)');
        importedNode.x = 0;
        importedNode.y = 0;
      }
    }

    // get the importedNode ID and the importedNode
    console.log('importedNode', importedNode);


    return { id: importedNode.id, node: importedNode };
    
  } catch (error) {
    console.error("Error creating cursor from SVG:", error);
    return { id: null, node: null, error: error.message };
  }
}

async function createConnections(params) {
  if (!params || !params.connections || !Array.isArray(params.connections)) {
    throw new Error('Missing or invalid connections parameter');
  }
  
  const { connections } = params;
  
  // Command ID for progress tracking
  const commandId = generateCommandId();
  sendProgressUpdate(
    commandId,
    "create_connections",
    "started",
    0,
    connections.length,
    0,
    `Starting to create ${connections.length} connections`
  );
  
  // Get default connector ID from client storage
  const defaultConnectorId = await figma.clientStorage.getAsync('defaultConnectorId');
  if (!defaultConnectorId) {
    throw new Error('No default connector set. Please try one of the following options to create connections:\n1. Create a connector in FigJam and copy/paste it to your current page, then run the "set_default_connector" command.\n2. Select an existing connector on the current page, then run the "set_default_connector" command.');
  }
  
  // Get the default connector
  const defaultConnector = await figma.getNodeByIdAsync(defaultConnectorId);
  if (!defaultConnector) {
    throw new Error(`Default connector not found with ID: ${defaultConnectorId}`);
  }
  if (defaultConnector.type !== 'CONNECTOR') {
    throw new Error(`Node is not a connector: ${defaultConnectorId}`);
  }
  
  // Results array for connection creation
  const results = [];
  let processedCount = 0;
  const totalCount = connections.length;
  
  // Preload fonts (used for text if provided)
  let fontLoaded = false;
  
  for (let i = 0; i < connections.length; i++) {
    try {
      const { startNodeId: originalStartId, endNodeId: originalEndId, text } = connections[i];
      let startId = originalStartId;
      let endId = originalEndId;

      // Check and potentially replace start node ID
      if (startId.includes(';')) {
        console.log(`Nested start node detected: ${startId}. Creating cursor node.`);
        const cursorResult = await createCursorNode(startId);
        if (!cursorResult || !cursorResult.id) {
          throw new Error(`Failed to create cursor node for nested start node: ${startId}`);
        }
        startId = cursorResult.id; 
      }  
      
      const startNode = await figma.getNodeByIdAsync(startId);
      if (!startNode) throw new Error(`Start node not found with ID: ${startId}`);

      // Check and potentially replace end node ID
      if (endId.includes(';')) {
        console.log(`Nested end node detected: ${endId}. Creating cursor node.`);
        const cursorResult = await createCursorNode(endId);
        if (!cursorResult || !cursorResult.id) {
          throw new Error(`Failed to create cursor node for nested end node: ${endId}`);
        }
        endId = cursorResult.id;
      }
      const endNode = await figma.getNodeByIdAsync(endId);
      if (!endNode) throw new Error(`End node not found with ID: ${endId}`);

      
      // Clone the default connector
      const clonedConnector = defaultConnector.clone();
      
      // Update connector name using potentially replaced node names
      clonedConnector.name = `TTF_Connector/${startNode.id}/${endNode.id}`;
      
      // Set start and end points using potentially replaced IDs
      clonedConnector.connectorStart = {
        endpointNodeId: startId,
        magnet: 'AUTO'
      };
      
      clonedConnector.connectorEnd = {
        endpointNodeId: endId,
        magnet: 'AUTO'
      };
      
      // Add text (if provided)
      if (text) {
        try {
          // Try to load the necessary fonts
          try {
            // First check if default connector has font and use the same
            if (defaultConnector.text && defaultConnector.text.fontName) {
              const fontName = defaultConnector.text.fontName;
              await figma.loadFontAsync(fontName);
              clonedConnector.text.fontName = fontName;
            } else {
              // Try default Inter font
              await figma.loadFontAsync({ family: "Inter", style: "Regular" });
            }
          } catch (fontError) {
            // If first font load fails, try another font style
            try {
              await figma.loadFontAsync({ family: "Inter", style: "Medium" });
            } catch (mediumFontError) {
              // If second font fails, try system font
              try {
                await figma.loadFontAsync({ family: "System", style: "Regular" });
              } catch (systemFontError) {
                // If all font loading attempts fail, throw error
                throw new Error(`Failed to load any font: ${fontError.message}`);
              }
            }
          }
          
          // Set the text
          clonedConnector.text.characters = text;
        } catch (textError) {
          console.error("Error setting text:", textError);
          // Continue with connection even if text setting fails
          results.push({
            id: clonedConnector.id,
            startNodeId: startNodeId,
            endNodeId: endNodeId,
            text: "",
            textError: textError.message
          });
          
          // Continue to next connection
          continue;
        }
      }
      
      // Add to results (using the *original* IDs for reference if needed)
      results.push({
        id: clonedConnector.id,
        originalStartNodeId: originalStartId,
        originalEndNodeId: originalEndId,
        usedStartNodeId: startId, // ID actually used for connection
        usedEndNodeId: endId,     // ID actually used for connection
        text: text || ""
      });
      
      // Update progress
      processedCount++;
      sendProgressUpdate(
        commandId,
        "create_connections",
        "in_progress",
        processedCount / totalCount,
        totalCount,
        processedCount,
        `Created connection ${processedCount}/${totalCount}`
      );
      
    } catch (error) {
      console.error("Error creating connection", error);
      // Continue processing remaining connections even if an error occurs
      processedCount++;
      sendProgressUpdate(
        commandId,
        "create_connections",
        "in_progress",
        processedCount / totalCount,
        totalCount,
        processedCount,
        `Error creating connection: ${error.message}`
      );
      
      results.push({
        error: error.message,
        connectionInfo: connections[i]
      });
    }
  }
  
  // Completion update
  sendProgressUpdate(
    commandId,
    "create_connections",
    "completed",
    1,
    totalCount,
    totalCount,
    `Completed creating ${results.length} connections`
  );
  
  return {
    success: true,
    count: results.length,
    connections: results
  };
}

// Set focus on a specific node
async function setFocus(params) {
  if (!params || !params.nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) {
    throw new Error(`Node with ID ${params.nodeId} not found`);
  }

  // Set selection to the node
  figma.currentPage.selection = [node];
  
  // Scroll and zoom to show the node in viewport
  figma.viewport.scrollAndZoomIntoView([node]);

  return {
    success: true,
    name: node.name,
    id: node.id,
    message: `Focused on node "${node.name}"`
  };
}

// Set selection to multiple nodes
async function setSelections(params) {
  if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
    throw new Error("Missing or invalid nodeIds parameter");
  }

  if (params.nodeIds.length === 0) {
    throw new Error("nodeIds array cannot be empty");
  }

  // Get all valid nodes
  const nodes = [];
  const notFoundIds = [];
  
  for (const nodeId of params.nodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node) {
      nodes.push(node);
    } else {
      notFoundIds.push(nodeId);
    }
  }

  if (nodes.length === 0) {
    throw new Error(`No valid nodes found for the provided IDs: ${params.nodeIds.join(', ')}`);
  }

  // Set selection to the nodes
  figma.currentPage.selection = nodes;
  
  // Scroll and zoom to show all nodes in viewport
  figma.viewport.scrollAndZoomIntoView(nodes);

  const selectedNodes = nodes.map(node => ({
    name: node.name,
    id: node.id
  }));

  return {
    success: true,
    count: nodes.length,
    selectedNodes: selectedNodes,
    notFoundIds: notFoundIds,
    message: `Selected ${nodes.length} nodes${notFoundIds.length > 0 ? ` (${notFoundIds.length} not found)` : ''}`
  };
}

// ---- Variables helpers ----
function parseVariableValue(type, value) {
  if (type === "COLOR") {
    if (typeof value === "string") {
      const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value);
      if (!m) throw new Error(`Invalid color "${value}" (expected #RRGGBB or #RRGGBBAA)`);
      const n = parseInt(m[1], 16);
      return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
    }
    if (value && typeof value === "object" && ["r", "g", "b"].every((k) => typeof value[k] === "number" && value[k] >= 0 && value[k] <= 1)) {
      return { r: value.r, g: value.g, b: value.b, a: value.a === undefined ? 1 : value.a };
    }
    throw new Error("Invalid color value");
  }
  if (type === "FLOAT") {
    if (typeof value !== "number" || !isFinite(value)) throw new Error("Number variable needs a finite number value");
    return value;
  }
  if (type === "STRING") {
    if (typeof value !== "string") throw new Error("Text variable needs a string value");
    return value;
  }
  if (type === "BOOLEAN") {
    if (typeof value !== "boolean") throw new Error("Boolean variable needs a boolean value");
    return value;
  }
  throw new Error(`Unsupported variable type: ${type}`);
}

function resolveModeId(collection, mode) {
  const found = collection.modes.find((m) => m.modeId === mode || m.name === mode);
  if (!found) {
    throw new Error(`Mode "${mode}" not found in collection "${collection.name}". Available: ${collection.modes.map((m) => m.name + " (" + m.modeId + ")").join(", ")}`);
  }
  return found.modeId;
}

async function getVariableOrThrow(variableId) {
  if (!variableId || typeof variableId !== "string") throw new Error("Missing variableId parameter");
  const variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) throw new Error(`Variable not found with ID: ${variableId}`);
  return variable;
}

function colorToHex(c) {
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b) + (c.a !== undefined && c.a < 1 ? h(c.a) : "");
}

// Serializes a variable value without ever throwing. Injectable name resolver (tests).
// Cases: alias (id + name if readable), missing or external alias, RGB/RGBA color,
// number, string, boolean, null/undefined, everything else.
function serializeVariableValue(value, aliasInfo) {
  try {
    if (value === undefined || value === null) return { empty: true, value: null };
    const t = typeof value;
    if (t === "number") return Number.isFinite(value) ? value : { unsupported: "number", repr: String(value) };
    if (t === "string" || t === "boolean") return value;
    if (t === "object") {
      if (value.type === "VARIABLE_ALIAS") {
        const out = { alias: value.id };
        const info = aliasInfo && aliasInfo(value.id);
        if (info && info.name) out.aliasName = info.name;
        if (info && info.collection) out.aliasCollection = info.collection;
        if (info && info.status && info.status !== "local") out.aliasStatus = info.status;
        return out;
      }
      if (typeof value.r === "number" && typeof value.g === "number" && typeof value.b === "number") {
        return colorToHex(value);
      }
      return { unsupported: "object", repr: JSON.stringify(value) };
    }
    return { unsupported: t, repr: String(value) };
  } catch (e) {
    return { unreadable: describeThrown(e, "serializeVariableValue") };
  }
}

const LOCAL_VARIABLES_BATCH = 50;

// Reads all local variables. A variable that fails is returned with its reason;
// the rest is returned normally. Reads in batches, with an "in progress" signal between batches.
async function getLocalVariables(commandId, params) {
  const prm = params || {};
  const deadline = Date.now() + lmBudget(prm);
  const startC = prm.cursor && Number.isInteger(prm.cursor.collection) ? prm.cursor.collection : 0;
  const startV = prm.cursor && Number.isInteger(prm.cursor.variable) ? prm.cursor.variable : 0;
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collectionNames = {};
  for (const c of collections) collectionNames[c.id] = c.name;
  // A single read of all local variables: one call per variable was the source of the delays.
  const localMap = await lmLocalVariableMap();
  const nameCache = new Map();
  const total = collections.reduce((n, c) => n + (c.variableIds ? c.variableIds.length : 0), 0);

  // Name of the variable targeted by an alias: local, missing or external (library).
  async function resolveAlias(id) {
    if (nameCache.has(id)) return nameCache.get(id);
    let info;
    try {
      const target = localMap.has(id) ? localMap.get(id) : await figma.variables.getVariableByIdAsync(id);
      if (!target) info = { status: "not_found" };
      else if (target.remote) info = { name: target.name, status: "external", collection: target.variableCollectionId };
      else info = { name: target.name, status: "local", collection: collectionNames[target.variableCollectionId] };
    } catch (e) {
      info = { status: "unreadable: " + describeThrown(e, "get_local_variables") };
    }
    nameCache.set(id, info);
    return info;
  }

  const out = [];
  let read = 0;
  let failed = 0;
  let processed = 0;
  let nextCursor = null;
  for (let ci = 0; ci < collections.length; ci++) {
    const c = collections[ci];
    if (ci < startC) { continue; }
    const variables = [];
    const failures = [];
    let ids = [];
    let modes = [];
    try { ids = Array.from(c.variableIds || []); } catch (e) { failures.push({ id: null, name: null, collection: c.name, error: describeThrown(e, "variableIds") }); failed++; }
    try { modes = Array.from(c.modes || []); } catch (e) { failures.push({ id: null, name: null, collection: c.name, error: describeThrown(e, "modes") }); failed++; }
    let stoppedAt = -1;
    for (let i = ci === startC ? startV : 0; i < ids.length; i++) {
      if (Date.now() > deadline) { stoppedAt = i; break; }
      const id = ids[i];
      let v = null;
      try {
        v = localMap.has(id) ? localMap.get(id) : await figma.variables.getVariableByIdAsync(id);
        if (!v) {
          failures.push({ id, name: null, collection: c.name, error: "variable not found (read returned null)" });
          failed++;
          continue;
        }
        const raw = v.valuesByMode || {};
        const valuesByMode = {};
        for (const m of modes) {
          const val = raw[m.modeId];
          // Resolve the alias name before serialization (which stays synchronous).
          let info = null;
          if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS") info = await resolveAlias(val.id);
          valuesByMode[m.name] = serializeVariableValue(val, () => info);
        }
        variables.push({ id: v.id, name: v.name, type: v.resolvedType, scopes: v.scopes, description: v.description, valuesByMode });
        read++;
      } catch (e) {
        let name = null;
        try { name = v ? v.name : null; } catch (e2) { name = null; }
        failures.push({ id, name, collection: c.name, error: describeThrown(e, "get_local_variables") });
        failed++;
      }
      processed++;
    }
    let modeList = [];
    try { modeList = modes.map((m) => ({ id: m.modeId, name: m.name })); } catch (e) { modeList = []; }
    const entry = { id: c.id, name: c.name, modes: modeList, variables };
    if (failures.length) entry.failures = failures;
    out.push(entry);
    if (stoppedAt >= 0) { nextCursor = { collection: ci, variable: stoppedAt }; break; }
  }
  const res = { collections: out, count: { read, failed, total }, complete: nextCursor === null };
  if (nextCursor) res.nextCursor = nextCursor;
  return res;
}

async function createVariableCollection(params) {
  const { name, modes } = params || {};
  if (!name || typeof name !== "string") throw new Error("Missing name parameter");
  if (!Array.isArray(modes) || modes.length === 0 || modes.some((m) => typeof m !== "string" || !m)) {
    throw new Error("modes must be a non-empty array of non-empty strings");
  }
  if (new Set(modes).size !== modes.length) throw new Error("Mode names must be unique");
  const collection = figma.variables.createVariableCollection(name);
  collection.renameMode(collection.modes[0].modeId, modes[0]);
  for (let i = 1; i < modes.length; i++) collection.addMode(modes[i]);
  return {
    id: collection.id,
    name: collection.name,
    modes: collection.modes.map((m) => ({ id: m.modeId, name: m.name })),
  };
}

async function createVariable(params) {
  const { collectionId, name, type, values } = params || {};
  if (!collectionId || typeof collectionId !== "string") throw new Error("Missing collectionId parameter");
  if (!name || typeof name !== "string") throw new Error("Missing name parameter");
  if (!["COLOR", "FLOAT", "STRING", "BOOLEAN"].includes(type)) throw new Error("type must be COLOR, FLOAT, STRING or BOOLEAN");
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("values must be an object keyed by mode");
  const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
  if (!collection) throw new Error(`Collection not found with ID: ${collectionId}`);
  // Validate everything before writing anything
  const parsed = Object.keys(values).map((mode) => ({
    modeId: resolveModeId(collection, mode),
    value: parseVariableValue(type, values[mode]),
  }));
  const variable = figma.variables.createVariable(name, collection, type);
  try {
    for (const p of parsed) variable.setValueForMode(p.modeId, p.value);
  } catch (e) {
    variable.remove();
    throw e;
  }
  return { id: variable.id, name: variable.name, type: variable.resolvedType, collectionId: collection.id };
}

async function setVariableValue(params) {
  const { variableId, mode, value } = params || {};
  if (!mode || typeof mode !== "string") throw new Error("Missing mode parameter");
  if (value === undefined) throw new Error("Missing value parameter");
  const variable = await getVariableOrThrow(variableId);
  const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
  if (!collection) throw new Error("Collection of the variable not found");
  const modeId = resolveModeId(collection, mode);
  variable.setValueForMode(modeId, parseVariableValue(variable.resolvedType, value));
  return { id: variable.id, name: variable.name, type: variable.resolvedType, modeId, value: serializeVariableValue(variable.valuesByMode[modeId]) };
}

async function setVariableScopes(params) {
  const { variableId, scopes } = params || {};
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((s) => typeof s !== "string")) {
    throw new Error("scopes must be a non-empty array of strings");
  }
  const variable = await getVariableOrThrow(variableId);
  variable.scopes = scopes;
  return { id: variable.id, name: variable.name, scopes: variable.scopes };
}

async function setVariableDescription(params) {
  const { variableId, description } = params || {};
  if (typeof description !== "string") throw new Error("description must be a string");
  const variable = await getVariableOrThrow(variableId);
  variable.description = description;
  return { id: variable.id, name: variable.name, description: variable.description };
}

async function bindVariable(params) {
  const { nodeId, property, variableId, index } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  const FIELDS = {
    CORNER_RADIUS: ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"],
    PADDING: ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"],
    CORNER_TOP_LEFT: ["topLeftRadius"],
    CORNER_TOP_RIGHT: ["topRightRadius"],
    CORNER_BOTTOM_LEFT: ["bottomLeftRadius"],
    CORNER_BOTTOM_RIGHT: ["bottomRightRadius"],
    PADDING_TOP: ["paddingTop"],
    PADDING_BOTTOM: ["paddingBottom"],
    PADDING_LEFT: ["paddingLeft"],
    PADDING_RIGHT: ["paddingRight"],
    ITEM_SPACING: ["itemSpacing"],
    WIDTH: ["width"],
    HEIGHT: ["height"],
  };
  if (property !== "FILL" && property !== "STROKE" && !FIELDS[property]) {
    throw new Error("property must be FILL, STROKE, CORNER_RADIUS, PADDING, PADDING_TOP, PADDING_BOTTOM, PADDING_LEFT, PADDING_RIGHT, CORNER_TOP_LEFT, CORNER_TOP_RIGHT, CORNER_BOTTOM_LEFT, CORNER_BOTTOM_RIGHT, ITEM_SPACING, WIDTH or HEIGHT");
  }
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  const variable = await getVariableOrThrow(variableId);

  if (property === "FILL" || property === "STROKE") {
    if (variable.resolvedType !== "COLOR") throw new Error(`${property} needs a COLOR variable, got ${variable.resolvedType}`);
    const key = property === "FILL" ? "fills" : "strokes";
    if (!(key in node)) throw new Error(`Node does not support ${key}: ${nodeId}`);
    const paints = node[key];
    if (paints === figma.mixed || !Array.isArray(paints)) throw new Error(`Node has mixed ${key}, cannot bind`);
    const i = index === undefined ? 0 : index;
    if (!paints[i]) throw new Error(`Node has no paint at index ${i} in ${key}`);
    if (paints[i].type !== "SOLID") throw new Error(`Paint ${i} is ${paints[i].type}, only SOLID paints can be bound`);
    const next = paints.slice();
    next[i] = figma.variables.setBoundVariableForPaint(paints[i], "color", variable);
    node[key] = next;
  } else {
    if (variable.resolvedType !== "FLOAT") throw new Error(`${property} needs a FLOAT variable, got ${variable.resolvedType}`);
    const fields = FIELDS[property];
    for (const f of fields) {
      if (!(f in node)) throw new Error(`Node type ${node.type} does not support ${property}`);
    }
    if ((property.startsWith("PADDING") || property === "ITEM_SPACING") && node.layoutMode === "NONE") {
      throw new Error(`${property} needs an auto-layout frame (layoutMode must not be NONE)`);
    }
    for (const f of fields) node.setBoundVariable(f, variable);
  }
  return { id: node.id, name: node.name, property, variableId: variable.id, variableName: variable.name };
}

async function renameVariableCollection(params) {
  const { collection: ref, name } = params || {};
  if (!ref || typeof ref !== "string") throw new Error("Missing collection parameter");
  if (!name || typeof name !== "string" || name.length > 200) throw new Error("name must be a non-empty string of 200 characters at most");
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let c = collections.find((x) => x.id === ref);
  if (!c) {
    const byName = collections.filter((x) => x.name === ref);
    if (byName.length > 1) throw new Error(`Several collections are named "${ref}", use the ID`);
    c = byName[0];
  }
  if (!c) throw new Error(`Collection not found: ${ref}`);
  const before = c.name;
  c.name = name;
  return { id: c.id, before, name: c.name, variables: c.variableIds.length };
}

async function createPage(params) {
  const { name, activate } = params || {};
  if (!name || typeof name !== "string" || name.length > 200) throw new Error("name must be a non-empty string of 200 characters at most");
  const same = figma.root.children.filter((pg) => pg.name === name);
  if (same.length) throw new Error(`A page named "${name}" already exists (${same[0].id})`);
  const page = figma.createPage();
  page.name = name;
  if (activate) await figma.setCurrentPageAsync(page);
  return { id: page.id, name: page.name, active: figma.currentPage.id === page.id };
}

async function setInstanceProperties(params) {
  const { nodeId, properties } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new Error("properties must be an object {name: value}");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (node.type !== "INSTANCE") throw new Error(`Node is not an INSTANCE (got ${node.type})`);
  // Text property names carry a #id suffix: the short name is accepted
  const defs = node.componentProperties || {};
  const resolved = {};
  for (const [k, v] of Object.entries(properties)) {
    if (k in defs) { resolved[k] = v; continue; }
    const hit = Object.keys(defs).filter((d) => d.split("#")[0] === k);
    if (hit.length !== 1) throw new Error(`Unknown or ambiguous property "${k}". Available: ${Object.keys(defs).join(", ")}`);
    resolved[hit[0]] = v;
  }
  // A font must be loaded before changing a text
  if (Object.values(resolved).some((v) => typeof v === "string")) {
    const texts = node.findAll((n) => n.type === "TEXT");
    for (const t of texts) {
      const fns = t.fontName === figma.mixed ? t.getRangeAllFontNames(0, t.characters.length) : [t.fontName];
      for (const f of fns) await figma.loadFontAsync(f);
    }
  }
  node.setProperties(resolved);
  return { id: node.id, name: node.name, componentProperties: node.componentProperties };
}

async function convertToComponent(params) {
  const { nodeId } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  const comp = figma.createComponentFromNode(node);
  return { id: comp.id, name: comp.name, type: comp.type };
}

async function combineAsVariants(params) {
  const { nodeIds, parentId, name } = params || {};
  if (!Array.isArray(nodeIds) || nodeIds.length === 0 || nodeIds.length > 200) throw new Error("nodeIds must be a list of 1 to 200 component IDs");
  const comps = [];
  for (const id of nodeIds) {
    const n = await figma.getNodeByIdAsync(id);
    if (!n) throw new Error(`Node not found with ID: ${id}`);
    if (n.type !== "COMPONENT") throw new Error(`Node ${id} is not a COMPONENT (got ${n.type})`);
    comps.push(n);
  }
  let parent = comps[0].parent;
  if (parentId) {
    parent = await figma.getNodeByIdAsync(parentId);
    if (!parent || !("appendChild" in parent)) throw new Error(`Invalid parent: ${parentId}`);
  }
  const set = figma.combineAsVariants(comps, parent);
  if (name) set.name = name;
  return { id: set.id, name: set.name, children: set.children.map((c) => ({ id: c.id, name: c.name })) };
}

async function addComponentProperty(params) {
  const { nodeId, name, type, defaultValue } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  if (!name || typeof name !== "string") throw new Error("Missing name parameter");
  if (!["TEXT", "BOOLEAN", "INSTANCE_SWAP"].includes(type)) throw new Error("type must be TEXT, BOOLEAN or INSTANCE_SWAP");
  if (type === "INSTANCE_SWAP" && typeof defaultValue !== "string") throw new Error("defaultValue must be a component ID for INSTANCE_SWAP");
  if (type === "TEXT" && typeof defaultValue !== "string") throw new Error("defaultValue must be a string for TEXT");
  if (type === "BOOLEAN" && typeof defaultValue !== "boolean") throw new Error("defaultValue must be a boolean for BOOLEAN");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (node.type !== "COMPONENT_SET" && node.type !== "COMPONENT") throw new Error(`Node must be a COMPONENT_SET or COMPONENT (got ${node.type})`);
  const propertyId = node.addComponentProperty(name, type, defaultValue);
  return { id: node.id, name: node.name, propertyId };
}

async function setComponentPropertyReference(params) {
  const { nodeId, field, propertyId } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  if (!["characters", "visible", "mainComponent"].includes(field)) throw new Error("field must be characters, visible or mainComponent");
  if (field === "mainComponent") { const n0 = await figma.getNodeByIdAsync(nodeId); if (!n0 || n0.type !== "INSTANCE") throw new Error("mainComponent needs an INSTANCE node"); }
  if (!propertyId || typeof propertyId !== "string") throw new Error("Missing propertyId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (field === "characters" && node.type !== "TEXT") throw new Error(`characters needs a TEXT node (got ${node.type})`);
  const refs = Object.assign({}, node.componentPropertyReferences || {});
  refs[field] = propertyId;
  node.componentPropertyReferences = refs;
  return { id: node.id, name: node.name, references: node.componentPropertyReferences };
}

async function setStrokeOptions(params) {
  const { nodeId, align, weight } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (!("strokeAlign" in node)) throw new Error(`Node type ${node.type} does not support strokes: ${nodeId}`);
  if (align !== undefined) {
    if (!["INSIDE", "OUTSIDE", "CENTER"].includes(align)) throw new Error("align must be INSIDE, OUTSIDE or CENTER");
    node.strokeAlign = align;
  }
  if (weight !== undefined) {
    if (typeof weight !== "number" || weight < 0) throw new Error("weight must be a number >= 0");
    node.strokeWeight = weight;
  }
  return { id: node.id, name: node.name, strokeAlign: node.strokeAlign, strokeWeight: node.strokeWeight };
}

async function setCornerRadii(params) {
  const { nodeId, topLeft, topRight, bottomRight, bottomLeft } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (!("topLeftRadius" in node)) throw new Error(`Node type ${node.type} has no per-corner radii: ${nodeId}`);
  for (const [k, v] of [["topLeftRadius", topLeft], ["topRightRadius", topRight], ["bottomRightRadius", bottomRight], ["bottomLeftRadius", bottomLeft]]) {
    if (v !== undefined) {
      if (typeof v !== "number" || v < 0) throw new Error(`${k} must be a number >= 0`);
      node[k] = v;
    }
  }
  return { id: node.id, name: node.name, radii: [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] };
}

async function setLayoutPositioning(params) {
  const { nodeId, positioning, horizontal, vertical, x, y } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  if (!["AUTO", "ABSOLUTE"].includes(positioning)) throw new Error("positioning must be AUTO or ABSOLUTE");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (!("layoutPositioning" in node)) throw new Error(`Node type ${node.type} has no layoutPositioning: ${nodeId}`);
  node.layoutPositioning = positioning;
  if (positioning === "ABSOLUTE") {
    if (x !== undefined) node.x = x;
    if (y !== undefined) node.y = y;
    if (horizontal || vertical) {
      node.constraints = { horizontal: horizontal || node.constraints.horizontal, vertical: vertical || node.constraints.vertical };
    }
  }
  return { id: node.id, name: node.name, layoutPositioning: node.layoutPositioning, constraints: node.constraints, x: node.x, y: node.y };
}

async function createTextStyle(params) {
  const { name, fontFamily, fontStyle, fontSize, lineHeightPercent, letterSpacingPercent, fontFamilyVariable, fontWeightVariable, fontSizeVariable } = params || {};
  if (!name || typeof name !== "string") throw new Error("Missing name parameter");
  if (!fontFamily || !fontStyle) throw new Error("Missing fontFamily or fontStyle");
  if (typeof fontSize !== "number" || fontSize <= 0) throw new Error("fontSize must be a positive number");
  const existing = (await figma.getLocalTextStylesAsync()).filter((st) => st.name === name);
  if (existing.length) throw new Error(`A text style named "${name}" already exists (${existing[0].id})`);
  await figma.loadFontAsync({ family: fontFamily, style: fontStyle });
  const st = figma.createTextStyle();
  st.name = name;
  st.fontName = { family: fontFamily, style: fontStyle };
  st.fontSize = fontSize;
  const lhNew = lmLineHeight(params || {});
  if (lhNew !== undefined) st.lineHeight = lhNew;
  if (letterSpacingPercent !== undefined) st.letterSpacing = { unit: "PERCENT", value: letterSpacingPercent };
  const bound = {};
  for (const [field, ref] of [["fontFamily", fontFamilyVariable], ["fontWeight", fontWeightVariable], ["fontSize", fontSizeVariable]]) {
    if (ref) {
      const v = await getVariableOrThrow(ref);
      st.setBoundVariable(field, v);
      bound[field] = v.name;
    }
  }
  return { id: st.id, name: st.name, bound, lineHeight: st.lineHeight, letterSpacing: st.letterSpacing };
}

async function getClipsContent(params) {
  const { nodeId } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (!("clipsContent" in node)) throw new Error(`Node type ${node.type} has no clipsContent: ${nodeId}`);
  return { id: node.id, name: node.name, clipsContent: node.clipsContent };
}

async function setClipsContent(params) {
  const { nodeId, clipsContent } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  if (typeof clipsContent !== "boolean") throw new Error("clipsContent must be a boolean");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (!("clipsContent" in node)) throw new Error(`Node type ${node.type} has no clipsContent: ${nodeId}`);
  node.clipsContent = clipsContent;
  return { id: node.id, name: node.name, clipsContent: node.clipsContent };
}

async function clearFills(params) {
  const { nodeId } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (!("fills" in node)) throw new Error(`Node type ${node.type} does not support fills: ${nodeId}`);
  const before = node.fills === figma.mixed ? null : node.fills.length;
  node.fills = [];
  return { id: node.id, name: node.name, removed: before, fillsCount: node.fills.length };
}

async function setTextStyle(params) {
  const { nodeId, style } = params || {};
  if (!nodeId || typeof nodeId !== "string") throw new Error("Missing nodeId parameter");
  if (!style || typeof style !== "string") throw new Error("Missing style parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (node.type !== "TEXT") throw new Error(`Node is not a text node: ${nodeId} (${node.type})`);
  const styles = await figma.getLocalTextStylesAsync();
  let found = styles.find((s) => s.id === style);
  if (!found) {
    const byName = styles.filter((s) => s.name === style);
    if (byName.length > 1) throw new Error(`Several text styles are named "${style}", use the ID`);
    found = byName[0];
  }
  if (!found) {
    throw new Error(`Text style not found: "${style}". Available: ${styles.map((s) => s.name).join(", ") || "none"}`);
  }
  if (found.fontName && found.fontName !== figma.mixed) await figma.loadFontAsync(found.fontName);
  await node.setTextStyleIdAsync(found.id);
  return { id: node.id, name: node.name, styleId: found.id, styleName: found.name };
}

async function setExplicitVariableMode(params) {
  const { node: nodeRef, collection: collectionRef, mode, clear } = params || {};
  if (!nodeRef || typeof nodeRef !== "string") throw new Error("Missing node parameter");
  if (!collectionRef || typeof collectionRef !== "string") throw new Error("Missing collection parameter");
  if (!clear && (!mode || typeof mode !== "string")) throw new Error("Missing mode parameter (or set clear to true)");

  // Node: by id, otherwise by name on the current page
  let node = await figma.getNodeByIdAsync(nodeRef);
  if (!node) {
    const byName = figma.currentPage.findAll((n) => n.name === nodeRef);
    if (byName.length === 0) throw new Error(`Node not found with ID or name: ${nodeRef}`);
    if (byName.length > 1) throw new Error(`Several nodes are named "${nodeRef}", use the ID`);
    node = byName[0];
  }
  if (!("setExplicitVariableModeForCollection" in node)) {
    throw new Error(`Node type ${node.type} does not support explicit variable modes: ${node.id}`);
  }

  // Collection: by id, otherwise by name
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let collection = collections.find((c) => c.id === collectionRef);
  if (!collection) {
    const byName = collections.filter((c) => c.name === collectionRef);
    if (byName.length === 0) throw new Error(`Collection not found: ${collectionRef}`);
    if (byName.length > 1) throw new Error(`Several collections are named "${collectionRef}", use the ID`);
    collection = byName[0];
  }

  if (clear) {
    node.clearExplicitVariableModeForCollection(collection);
    return { id: node.id, name: node.name, collectionId: collection.id, collectionName: collection.name, cleared: true };
  }
  const modeId = resolveModeId(collection, mode);
  node.setExplicitVariableModeForCollection(collection, modeId);
  const modeName = collection.modes.find((m) => m.modeId === modeId).name;
  return { id: node.id, name: node.name, collectionId: collection.id, collectionName: collection.name, modeId, modeName, cleared: false };
}

// ---------------------------------------------------------------------------
// build_tree: builds a tree of nodes described by data, in a single call.
// No code in the description: a strict validator rejects any unknown key.
// All or nothing: if a step fails, the root created by this call is deleted
// (its children go with it).
// ---------------------------------------------------------------------------
const BUILD_TREE_MAX_DEPTH = 12;
const BUILD_TREE_MAX_NODES = 500;
const BT_ENUMS = {
  type: ["FRAME", "RECTANGLE", "TEXT", "ELLIPSE", "INSTANCE"],
  layoutMode: ["NONE", "HORIZONTAL", "VERTICAL"],
  layoutWrap: ["NO_WRAP", "WRAP"],
  align: ["MIN", "MAX", "CENTER", "SPACE_BETWEEN"],
  counterAlign: ["MIN", "MAX", "CENTER", "BASELINE"],
  sizing: ["FIXED", "HUG", "FILL"],
  bindProperty: ["FILL", "STROKE", "CORNER_RADIUS", "CORNER_TOP_LEFT", "CORNER_TOP_RIGHT", "CORNER_BOTTOM_LEFT", "CORNER_BOTTOM_RIGHT", "PADDING", "PADDING_TOP", "PADDING_BOTTOM", "PADDING_LEFT", "PADDING_RIGHT", "ITEM_SPACING", "WIDTH", "HEIGHT"],
};
const BT_COMMON_KEYS = [
  "type", "name", "x", "y", "width", "height", "fill", "stroke", "strokeWeight",
  "cornerRadius", "layoutSizingHorizontal", "layoutSizingVertical", "bindings", "explicitModes",
  "strokeAlign", "cornerRadii", "layoutPositioning", "constraintH", "constraintV", "noFill",
  "props", "fieldBindings", "effects",
];
const BT_KEYS = {
  FRAME: BT_COMMON_KEYS.concat([
    "layoutMode", "layoutWrap", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "itemSpacing", "primaryAxisAlignItems", "counterAxisAlignItems", "children", "asComponent",
  ]),
  RECTANGLE: BT_COMMON_KEYS,
  ELLIPSE: BT_COMMON_KEYS,
  INSTANCE: BT_COMMON_KEYS.concat(["componentId", "properties"]),
  TEXT: BT_COMMON_KEYS.concat(["text", "fontSize", "fontWeight", "textStyle"]),
};

function btFail(path, msg) {
  throw new Error(`build_tree : ${path} ${msg}`);
}
function btIsPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function btCheckOnlyKeys(obj, allowed, path) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) btFail(path, `unknown key "${k}" (only data is accepted)`);
  }
}
function btCheckNumber(v, path, min, max) {
  if (typeof v !== "number" || !isFinite(v)) btFail(path, "must be a number");
  if (min !== undefined && v < min) btFail(path, `must be >= ${min}`);
  if (max !== undefined && v > max) btFail(path, `must be <= ${max}`);
}
function btCheckString(v, path, maxLen) {
  if (typeof v !== "string" || v.length === 0) btFail(path, "must be a non-empty string");
  if (v.length > maxLen) btFail(path, `exceeds ${maxLen} characters`);
}
function btCheckEnum(v, list, path) {
  if (!list.includes(v)) btFail(path, `doit valoir l'un de : ${list.join(", ")}`);
}
function btCheckColor(c, path) {
  if (!btIsPlainObject(c)) btFail(path, "must be {r,g,b,a?} with values from 0 to 1");
  btCheckOnlyKeys(c, ["r", "g", "b", "a"], path);
  for (const k of ["r", "g", "b"]) {
    if (c[k] === undefined) btFail(path, `« ${k} » manquant`);
    btCheckNumber(c[k], `${path}.${k}`, 0, 1);
  }
  if (c.a !== undefined) btCheckNumber(c.a, `${path}.a`, 0, 1);
}

// Validates recursively; returns the number of nodes.
function btValidate(node, path, depth, counter) {
  if (!btIsPlainObject(node)) btFail(path, "must be an object");
  if (depth > BUILD_TREE_MAX_DEPTH) btFail(path, `exceeds the maximum depth (${BUILD_TREE_MAX_DEPTH})`);
  counter.n += 1;
  if (counter.n > BUILD_TREE_MAX_NODES) btFail(path, `exceeds ${BUILD_TREE_MAX_NODES} nodes`);
  btCheckEnum(node.type, BT_ENUMS.type, `${path}.type`);
  btCheckOnlyKeys(node, BT_KEYS[node.type], path);

  if (node.name !== undefined) btCheckString(node.name, `${path}.name`, 200);
  if (node.strokeAlign !== undefined) btCheckEnum(node.strokeAlign, ["INSIDE", "OUTSIDE", "CENTER"], `${path}.strokeAlign`);
  if (node.layoutPositioning !== undefined) btCheckEnum(node.layoutPositioning, ["AUTO", "ABSOLUTE"], `${path}.layoutPositioning`);
  for (const k of ["constraintH", "constraintV"]) if (node[k] !== undefined) btCheckEnum(node[k], ["MIN", "MAX", "CENTER", "STRETCH", "SCALE"], `${path}.${k}`);
  if (node.props !== undefined && !btIsPlainObject(node.props)) btFail(`${path}.props`, "must be an object {property: value}");
  if (node.effects !== undefined && (!Array.isArray(node.effects) || node.effects.length > 8)) btFail(`${path}.effects`, "must be a list of at most 8 effects");
  if (node.fieldBindings !== undefined) {
    if (!Array.isArray(node.fieldBindings) || node.fieldBindings.length > 30) btFail(`${path}.fieldBindings`, "must be a list of at most 30 bindings");
    node.fieldBindings.forEach((b, i) => {
      if (!btIsPlainObject(b)) btFail(`${path}.fieldBindings[${i}]`, "must be an object");
      btCheckOnlyKeys(b, ["field", "variable"], `${path}.fieldBindings[${i}]`);
      btCheckEnum(b.field, X_BIND_FIELDS, `${path}.fieldBindings[${i}].field`);
      btCheckString(b.variable, `${path}.fieldBindings[${i}].variable`, 200);
    });
  }
  if (node.type === "INSTANCE") {
    btCheckString(node.componentId, `${path}.componentId`, 200);
    if (node.properties !== undefined && !btIsPlainObject(node.properties)) btFail(`${path}.properties`, "must be an object");
  }
  if (node.noFill !== undefined && typeof node.noFill !== "boolean") btFail(`${path}.noFill`, "must be a boolean");
  if (node.asComponent !== undefined && typeof node.asComponent !== "boolean") btFail(`${path}.asComponent`, "must be a boolean");
  if (node.cornerRadii !== undefined) {
    if (!btIsPlainObject(node.cornerRadii)) btFail(`${path}.cornerRadii`, "must be {topLeft,topRight,bottomRight,bottomLeft}");
    btCheckOnlyKeys(node.cornerRadii, ["topLeft", "topRight", "bottomRight", "bottomLeft"], `${path}.cornerRadii`);
    for (const k of Object.keys(node.cornerRadii)) btCheckNumber(node.cornerRadii[k], `${path}.cornerRadii.${k}`, 0, 100000);
  }
  for (const k of ["x", "y"]) if (node[k] !== undefined) btCheckNumber(node[k], `${path}.${k}`, -100000, 100000);
  for (const k of ["width", "height"]) if (node[k] !== undefined) btCheckNumber(node[k], `${path}.${k}`, 0.01, 100000);
  if (node.type === "TEXT" && node.height !== undefined) btFail(`${path}.height`, "does not exist on a text (height follows the content)");
  if (node.fill !== undefined) btCheckColor(node.fill, `${path}.fill`);
  if (node.stroke !== undefined) btCheckColor(node.stroke, `${path}.stroke`);
  if (node.strokeWeight !== undefined) btCheckNumber(node.strokeWeight, `${path}.strokeWeight`, 0, 1000);
  if (node.cornerRadius !== undefined) {
    if (node.type === "TEXT") btFail(`${path}.cornerRadius`, "does not exist on a text");
    btCheckNumber(node.cornerRadius, `${path}.cornerRadius`, 0, 100000);
  }
  for (const k of ["layoutSizingHorizontal", "layoutSizingVertical"]) {
    if (node[k] !== undefined) btCheckEnum(node[k], BT_ENUMS.sizing, `${path}.${k}`);
  }

  if (node.bindings !== undefined) {
    if (!Array.isArray(node.bindings) || node.bindings.length > 20) btFail(`${path}.bindings`, "must be a list of at most 20 bindings");
    node.bindings.forEach((b, i) => {
      const p = `${path}.bindings[${i}]`;
      if (!btIsPlainObject(b)) btFail(p, "must be an object");
      btCheckOnlyKeys(b, ["property", "variable"], p);
      btCheckEnum(b.property, BT_ENUMS.bindProperty, `${p}.property`);
      btCheckString(b.variable, `${p}.variable`, 200);
      if (node.type !== "FRAME" && ["PADDING", "PADDING_TOP", "PADDING_BOTTOM", "PADDING_LEFT", "PADDING_RIGHT", "ITEM_SPACING"].includes(b.property)) {
        btFail(`${p}.property`, `${b.property} only applies to an auto layout frame`);
      }
      if (node.type === "TEXT" && b.property === "CORNER_RADIUS") btFail(`${p}.property`, "CORNER_RADIUS does not exist on a text");
    });
  }
  if (node.explicitModes !== undefined) {
    if (node.type === "TEXT") btFail(`${path}.explicitModes`, "does not apply to a text");
    if (!Array.isArray(node.explicitModes) || node.explicitModes.length > 10) btFail(`${path}.explicitModes`, "must be a list of at most 10 modes");
    node.explicitModes.forEach((m, i) => {
      const p = `${path}.explicitModes[${i}]`;
      if (!btIsPlainObject(m)) btFail(p, "must be an object");
      btCheckOnlyKeys(m, ["collection", "mode"], p);
      btCheckString(m.collection, `${p}.collection`, 200);
      btCheckString(m.mode, `${p}.mode`, 200);
    });
  }

  if (node.type === "FRAME") {
    if (node.layoutMode !== undefined) btCheckEnum(node.layoutMode, BT_ENUMS.layoutMode, `${path}.layoutMode`);
    if (node.layoutWrap !== undefined) btCheckEnum(node.layoutWrap, BT_ENUMS.layoutWrap, `${path}.layoutWrap`);
    for (const k of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "itemSpacing"]) {
      if (node[k] !== undefined) btCheckNumber(node[k], `${path}.${k}`, 0, 100000);
    }
    if (node.primaryAxisAlignItems !== undefined) btCheckEnum(node.primaryAxisAlignItems, BT_ENUMS.align, `${path}.primaryAxisAlignItems`);
    if (node.counterAxisAlignItems !== undefined) btCheckEnum(node.counterAxisAlignItems, BT_ENUMS.counterAlign, `${path}.counterAxisAlignItems`);
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) btFail(`${path}.children`, "must be a list");
      node.children.forEach((c, i) => btValidate(c, `${path}.children[${i}]`, depth + 1, counter));
    }
  }
  if (node.type === "TEXT") {
    if (node.text === undefined) btFail(`${path}.text`, "manquant");
    if (typeof node.text !== "string" || node.text.length > 5000) btFail(`${path}.text`, "must be a string of at most 5000 characters");
    if (node.fontSize !== undefined) btCheckNumber(node.fontSize, `${path}.fontSize`, 1, 1000);
    if (node.fontWeight !== undefined) btCheckEnum(node.fontWeight, [100, 200, 300, 400, 500, 600, 700, 800, 900], `${path}.fontWeight`);
    if (node.textStyle !== undefined) btCheckString(node.textStyle, `${path}.textStyle`, 200);
  }
  return counter.n;
}

async function buildTree(params) {
  const { parentId, tree, commandId } = params || {};
  if (parentId !== undefined && (typeof parentId !== "string" || !parentId)) {
    throw new Error("build_tree: parentId must be a node id");
  }
  const counter = { n: 0 };
  btValidate(tree, "tree", 1, counter);
  const total = counter.n;

  const done = { n: 0 };
  let root = null; // root created by this call: the only one to delete on failure

  // Creates a node under parentId, then applies the rest; returns {id,name,type,children}
  async function build(node, parentNodeId, isRoot, path) {
    let created;
    const common = { x: node.x, y: node.y, name: node.name, parentId: parentNodeId };
    if (node.type === "FRAME") {
      const p = Object.assign({}, common, {
        width: node.width, height: node.height,
        fillColor: node.fill, strokeColor: node.stroke, strokeWeight: node.strokeWeight,
        layoutMode: node.layoutMode, layoutWrap: node.layoutWrap,
        paddingTop: node.paddingTop, paddingRight: node.paddingRight,
        paddingBottom: node.paddingBottom, paddingLeft: node.paddingLeft,
        primaryAxisAlignItems: node.primaryAxisAlignItems, counterAxisAlignItems: node.counterAxisAlignItems,
        layoutSizingHorizontal: node.layoutSizingHorizontal, layoutSizingVertical: node.layoutSizingVertical,
        itemSpacing: node.itemSpacing,
      });
      p.figmaDefaults = true;
      created = await createFrame(p);
    } else if (node.type === "RECTANGLE") {
      created = await createRectangle(Object.assign({}, common, { width: node.width, height: node.height }));
    } else if (node.type === "ELLIPSE") {
      created = await X_COMMANDS.create_ellipse({ parentId: parentNodeId, name: node.name, x: node.x, y: node.y, width: node.width, height: node.height });
    } else if (node.type === "INSTANCE") {
      const comp = await figma.getNodeByIdAsync(node.componentId);
      if (!comp || comp.type !== "COMPONENT") throw new Error(`build_tree: ${path}.componentId is not a component: ${node.componentId}`);
      const inst = comp.createInstance();
      const par = await resolveParentForCreate(parentNodeId);
      par.appendChild(inst);
      if (node.name) inst.name = node.name;
      if (node.x !== undefined) inst.x = node.x;
      if (node.y !== undefined) inst.y = node.y;
      if (node.properties) await setInstanceProperties({ nodeId: inst.id, properties: node.properties });
      created = { id: inst.id };
    } else {
      created = await createText(Object.assign({}, common, {
        text: node.text, fontSize: node.fontSize, fontWeight: node.fontWeight,
        fontColor: node.fill, figmaDefaults: true,
      }));
    }
    if (isRoot) root = created.id;
    const figNode = await figma.getNodeByIdAsync(created.id);

    // Type-specific settings, after attaching to the parent
    if (node.type === "RECTANGLE" || node.type === "ELLIPSE") {
      if (node.fill) figNode.fills = [{ type: "SOLID", color: { r: node.fill.r, g: node.fill.g, b: node.fill.b }, opacity: node.fill.a === undefined ? 1 : node.fill.a }];
      if (node.stroke) figNode.strokes = [{ type: "SOLID", color: { r: node.stroke.r, g: node.stroke.g, b: node.stroke.b }, opacity: node.stroke.a === undefined ? 1 : node.stroke.a }];
      if (node.strokeWeight !== undefined) figNode.strokeWeight = node.strokeWeight;
    }
    if (node.type === "TEXT" && node.stroke) {
      figNode.strokes = [{ type: "SOLID", color: { r: node.stroke.r, g: node.stroke.g, b: node.stroke.b }, opacity: node.stroke.a === undefined ? 1 : node.stroke.a }];
      if (node.strokeWeight !== undefined) figNode.strokeWeight = node.strokeWeight;
    }
    if (node.cornerRadius !== undefined) figNode.cornerRadius = node.cornerRadius;
    if (node.cornerRadii) {
      const cr = node.cornerRadii;
      if (cr.topLeft !== undefined) figNode.topLeftRadius = cr.topLeft;
      if (cr.topRight !== undefined) figNode.topRightRadius = cr.topRight;
      if (cr.bottomRight !== undefined) figNode.bottomRightRadius = cr.bottomRight;
      if (cr.bottomLeft !== undefined) figNode.bottomLeftRadius = cr.bottomLeft;
    }
    if (node.noFill) figNode.fills = [];
    if (node.props) await xApplyProps(figNode, node.props);
    if (node.effects) figNode.effects = await xBuildEffects(node.effects);
    if (node.strokeAlign && node.type !== "TEXT") figNode.strokeAlign = node.strokeAlign;
    if (node.layoutPositioning === "ABSOLUTE") {
      figNode.layoutPositioning = "ABSOLUTE";
      if (node.x !== undefined) figNode.x = node.x;
      if (node.y !== undefined) figNode.y = node.y;
      if (node.width !== undefined && node.height !== undefined) figNode.resize(node.width, node.height);
      if (node.constraintH || node.constraintV) {
        figNode.constraints = {
          horizontal: node.constraintH || figNode.constraints.horizontal,
          vertical: node.constraintV || figNode.constraints.vertical,
        };
      }
    }
    if (node.type === "TEXT" && node.width !== undefined) {
      figNode.textAutoResize = "HEIGHT";
      figNode.resize(node.width, figNode.height);
    }
    if (node.type !== "FRAME") {
      if (node.layoutSizingHorizontal) figNode.layoutSizingHorizontal = node.layoutSizingHorizontal;
      if (node.layoutSizingVertical) figNode.layoutSizingVertical = node.layoutSizingVertical;
      if (node.type === "TEXT" && node.layoutSizingHorizontal === "FILL") figNode.textAutoResize = "HEIGHT";
    }
    if (node.type === "TEXT" && node.textStyle) {
      await setTextStyle({ nodeId: created.id, style: node.textStyle });
    }

    // Variable bindings, then explicit modes
    for (const b of node.bindings || []) {
      if (b.property === "STROKE" && (!figNode.strokes || figNode.strokes.length === 0)) {
        figNode.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      }
      await bindVariable({ nodeId: created.id, property: b.property, variableId: b.variable });
    }
    for (const b of node.fieldBindings || []) await xBindField(figNode, b.field, b.variable);
    for (const m of node.explicitModes || []) {
      await setExplicitVariableMode({ node: created.id, collection: m.collection, mode: m.mode });
    }

    done.n += 1;
    if (commandId && (done.n % 10 === 0 || done.n === total)) {
      await sendProgressUpdate(
        commandId, "build_tree", done.n === total ? "completed" : "in_progress",
        Math.round((done.n / total) * 100), total, done.n,
        `build_tree: ${done.n}/${total} nodes`
      );
    }

    const out = { id: created.id, name: figNode.name, type: node.type };
    if (node.type === "FRAME" && node.children && node.children.length) {
      out.children = [];
      for (let i = 0; i < node.children.length; i++) {
        out.children.push(await build(node.children[i], created.id, false, `${path}.children[${i}]`));
      }
    }
    if (node.asComponent && node.type === "FRAME") {
      const comp = figma.createComponentFromNode(figNode);
      if (isRoot) root = comp.id;
      out.id = comp.id; out.name = comp.name; out.type = "COMPONENT";
    }
    return out;
  }

  try {
    // The parent is checked before any creation
    await resolveParentForCreate(parentId);
    const built = await build(tree, parentId, true, "tree");
    const ids = [];
    (function collect(n) { ids.push(n.id); (n.children || []).forEach(collect); })(built);
    return { created: total, rootId: built.id, ids, tree: built };
  } catch (error) {
    // All or nothing: delete what this call created
    let rolledBack = false;
    if (root) {
      try {
        const r = await figma.getNodeByIdAsync(root);
        if (r) { r.remove(); rolledBack = true; }
      } catch (e) {
        console.error("build_tree: removal failed", e);
      }
    }
    const suite = !root
      ? " (nothing was created)"
      : rolledBack
        ? " (everything created by this call was deleted)"
        : " (WARNING: deleting what had been created failed, check the parent)";
    throw new Error(`${error.message}${suite}`);
  }
}

// ---------------------------------------------------------------------------
// Full inspection: additional commands (properties, bindings, paints, effects, grids,
// variables, components, pages, prototype, shapes, text by range, raw read).
// No command writes design content to a log.
// ---------------------------------------------------------------------------
async function xNode(id) {
  if (!id || typeof id !== "string") throw new Error("Missing nodeId parameter");
  const n = await figma.getNodeByIdAsync(id);
  if (!n) throw new Error(`Node not found with ID: ${id}`);
  return n;
}
async function xNodes(ids, min) {
  if (!Array.isArray(ids) || ids.length < (min || 1) || ids.length > 200) throw new Error(`nodeIds must be a list of ${min || 1} to 200 node IDs`);
  const out = [];
  for (const id of ids) out.push(await xNode(id));
  return out;
}
async function xParent(parentId, fallback) {
  if (!parentId) return fallback || figma.currentPage;
  const p = await figma.getNodeByIdAsync(parentId);
  if (!p || !("appendChild" in p)) throw new Error(`Invalid parent: ${parentId}`);
  return p;
}
async function xCollection(ref) {
  if (!ref || typeof ref !== "string") throw new Error("Missing collection parameter");
  const all = await figma.variables.getLocalVariableCollectionsAsync();
  let c = all.find((x) => x.id === ref);
  if (!c) {
    const by = all.filter((x) => x.name === ref);
    if (by.length > 1) throw new Error(`Several collections are named "${ref}", use the ID`);
    c = by[0];
  }
  if (!c) throw new Error(`Collection not found: ${ref}`);
  return c;
}
async function xLoadTextFonts(node) {
  const texts = node.type === "TEXT" ? [node] : ("findAll" in node ? node.findAll((n) => n.type === "TEXT") : []);
  for (const t of texts) {
    if (t.characters.length === 0) { await figma.loadFontAsync(t.fontName === figma.mixed ? { family: "Inter", style: "Regular" } : t.fontName); continue; }
    const fns = t.fontName === figma.mixed ? t.getRangeAllFontNames(0, t.characters.length) : [t.fontName];
    for (const f of fns) await figma.loadFontAsync(f);
  }
}

const X_ENUMS = {
  blendMode: ["PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"],
  layoutMode: ["NONE", "HORIZONTAL", "VERTICAL"],
  layoutWrap: ["NO_WRAP", "WRAP"],
  primaryAxisSizingMode: ["FIXED", "AUTO"],
  counterAxisSizingMode: ["FIXED", "AUTO"],
  primaryAxisAlignItems: ["MIN", "MAX", "CENTER", "SPACE_BETWEEN"],
  counterAxisAlignItems: ["MIN", "MAX", "CENTER", "BASELINE"],
  counterAxisAlignContent: ["AUTO", "SPACE_BETWEEN"],
  layoutAlign: ["INHERIT", "STRETCH", "MIN", "CENTER", "MAX"],
  layoutPositioning: ["AUTO", "ABSOLUTE"],
  layoutSizingHorizontal: ["FIXED", "HUG", "FILL"],
  layoutSizingVertical: ["FIXED", "HUG", "FILL"],
  strokeAlign: ["INSIDE", "OUTSIDE", "CENTER"],
  strokeJoin: ["MITER", "BEVEL", "ROUND"],
  strokeCap: ["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"],
  textAutoResize: ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"],
  textAlignHorizontal: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"],
  textAlignVertical: ["TOP", "CENTER", "BOTTOM"],
  textCase: ["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"],
  textDecoration: ["NONE", "UNDERLINE", "STRIKETHROUGH"],
  textTruncation: ["DISABLED", "ENDING"],
  leadingTrim: ["NONE", "CAP_HEIGHT"],
};
const X_NUMBERS = ["opacity", "rotation", "x", "y", "width", "height", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "cornerSmoothing", "paragraphSpacing", "paragraphIndent", "layoutGrow", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "cornerRadius", "maxLines"];
const X_NULLABLE_NUMBERS = ["minWidth", "maxWidth", "minHeight", "maxHeight", "counterAxisSpacing"];
const X_BOOLEANS = ["visible", "locked", "clipsContent", "isMask", "itemReverseZIndex", "strokesIncludedInLayout"];
const X_STRINGS = ["name", "description"];
const X_FIRST = ["layoutMode", "layoutWrap", "primaryAxisSizingMode", "counterAxisSizingMode"];
const X_LAST = ["layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "width", "height", "constraints"];

async function xApplyProps(node, props) {
  if (!props || typeof props !== "object" || Array.isArray(props)) throw new Error("properties must be an object {name: value}");
  const allowed = [].concat(Object.keys(X_ENUMS), X_NUMBERS, X_NULLABLE_NUMBERS, X_BOOLEANS, X_STRINGS, ["constraints", "dashPattern"]);
  for (const k of Object.keys(props)) {
    if (!allowed.includes(k)) throw new Error(`Unknown property "${k}". Allowed: ${allowed.join(", ")}`);
  }
  if (node.type === "TEXT" || "findAll" in node) await xLoadTextFonts(node);
  const keys = Object.keys(props);
  const ordered = X_FIRST.filter((k) => keys.includes(k))
    .concat(keys.filter((k) => !X_FIRST.includes(k) && !X_LAST.includes(k)))
    .concat(X_LAST.filter((k) => keys.includes(k)));
  const sizeKeys = [];
  for (const k of ordered) {
    const v = props[k];
    if (k === "width" || k === "height") { sizeKeys.push(k); continue; }
    if (X_ENUMS[k]) {
      if (!X_ENUMS[k].includes(v)) throw new Error(`${k} must be one of ${X_ENUMS[k].join(", ")}`);
    } else if (X_NUMBERS.includes(k)) {
      if (typeof v !== "number" || !isFinite(v)) throw new Error(`${k} must be a number`);
    } else if (X_NULLABLE_NUMBERS.includes(k)) {
      if (v !== null && (typeof v !== "number" || !isFinite(v))) throw new Error(`${k} must be a number or null`);
    } else if (X_BOOLEANS.includes(k)) {
      if (typeof v !== "boolean") throw new Error(`${k} must be a boolean`);
    } else if (X_STRINGS.includes(k)) {
      if (typeof v !== "string") throw new Error(`${k} must be a string`);
    } else if (k === "constraints") {
      if (!v || typeof v !== "object") throw new Error("constraints must be {horizontal, vertical}");
      node.constraints = { horizontal: v.horizontal || node.constraints.horizontal, vertical: v.vertical || node.constraints.vertical };
      continue;
    } else if (k === "dashPattern") {
      if (!Array.isArray(v) || v.some((n) => typeof n !== "number")) throw new Error("dashPattern must be a list of numbers");
    }
    try {
      node[k] = v;
    } catch (e) {
      throw new Error(`Cannot set ${k} on a ${node.type}: ${e && e.message ? e.message : e}`);
    }
  }
  if (sizeKeys.length) {
    node.resize(typeof props.width === "number" ? props.width : node.width, typeof props.height === "number" ? props.height : node.height);
  }
}

const X_BIND_FIELDS = ["height", "width", "characters", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "visible", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "minHeight", "maxHeight", "minWidth", "maxWidth", "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "opacity", "counterAxisSpacing", "fontFamily", "fontSize", "fontStyle", "fontWeight", "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent"];
async function xBindField(node, field, variableId) {
  if (!X_BIND_FIELDS.includes(field)) throw new Error(`field must be one of ${X_BIND_FIELDS.join(", ")}`);
  if (variableId === null || variableId === undefined) { node.setBoundVariable(field, null); return { unbound: true }; }
  const v = await getVariableOrThrow(variableId);
  node.setBoundVariable(field, v);
  return { variable: v.name };
}

async function xBuildPaint(p) {
  if (!p || typeof p !== "object") throw new Error("a paint must be an object");
  const common = { visible: p.visible !== false, opacity: p.opacity === undefined ? 1 : p.opacity, blendMode: p.blendMode || "NORMAL" };
  if (p.type === "SOLID") {
    const c = p.color || { r: 0, g: 0, b: 0 };
    let paint = Object.assign({ type: "SOLID", color: { r: c.r, g: c.g, b: c.b } }, common);
    if (p.variable) {
      const v = await getVariableOrThrow(p.variable);
      if (v.resolvedType !== "COLOR") throw new Error(`Variable ${v.name} is ${v.resolvedType}, a COLOR is needed`);
      paint = figma.variables.setBoundVariableForPaint(paint, "color", v);
    }
    return paint;
  }
  if (typeof p.type === "string" && ["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"].includes(p.type)) {
    if (!Array.isArray(p.stops) || p.stops.length < 2) throw new Error("a gradient needs at least 2 stops {position, color{r,g,b,a}}");
    const a = ((p.angle || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return Object.assign({
      type: p.type,
      gradientStops: p.stops.map((st) => ({ position: st.position, color: { r: st.color.r, g: st.color.g, b: st.color.b, a: st.color.a === undefined ? 1 : st.color.a } })),
      gradientTransform: [[c, s, 0.5 - 0.5 * c - 0.5 * s], [-s, c, 0.5 + 0.5 * s - 0.5 * c]],
    }, common);
  }
  throw new Error("paint type must be SOLID or GRADIENT_LINEAR, GRADIENT_RADIAL, GRADIENT_ANGULAR, GRADIENT_DIAMOND (images: set_image_fill)");
}
async function xBuildEffect(e) {
  if (!e || typeof e !== "object") throw new Error("an effect must be an object");
  if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
    const c = e.color || { r: 0, g: 0, b: 0, a: 0.25 };
    let eff = {
      type: e.type, color: { r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 1 : c.a },
      offset: { x: (e.offset && e.offset.x) || 0, y: (e.offset && e.offset.y) || 0 },
      radius: e.radius || 0, spread: e.spread || 0, visible: e.visible !== false, blendMode: e.blendMode || "NORMAL",
    };
    if (e.colorVariable) {
      const v = await getVariableOrThrow(e.colorVariable);
      eff = figma.variables.setBoundVariableForEffect(eff, "color", v);
    }
    for (const [key, ref] of [["radius", e.radiusVariable], ["spread", e.spreadVariable], ["offsetX", e.offsetXVariable], ["offsetY", e.offsetYVariable]]) {
      if (ref) eff = figma.variables.setBoundVariableForEffect(eff, key, await getVariableOrThrow(ref));
    }
    return eff;
  }
  if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
    let blur = { type: e.type, blurType: "NORMAL", radius: e.radius || 0, visible: e.visible !== false };
    if (e.radiusVariable) blur = figma.variables.setBoundVariableForEffect(blur, "radius", await getVariableOrThrow(e.radiusVariable));
    return blur;
  }
  throw new Error("effect type must be DROP_SHADOW, INNER_SHADOW, LAYER_BLUR or BACKGROUND_BLUR");
}
async function xBuildEffects(list) {
  if (!Array.isArray(list) || list.length > 8) throw new Error("effects must be a list of 8 effects at most");
  const out = [];
  for (const e of list) out.push(await xBuildEffect(e));
  return out;
}

async function xResolveStyle(kind, ref) {
  const lists = {
    TEXT: () => figma.getLocalTextStylesAsync(), EFFECT: () => figma.getLocalEffectStylesAsync(),
    FILL: () => figma.getLocalPaintStylesAsync(), STROKE: () => figma.getLocalPaintStylesAsync(), GRID: () => figma.getLocalGridStylesAsync(),
  };
  if (!lists[kind]) throw new Error("kind must be TEXT, EFFECT, FILL, STROKE or GRID");
  const all = await lists[kind]();
  let found = all.find((s) => s.id === ref);
  if (!found) {
    const by = all.filter((s) => s.name === ref);
    if (by.length > 1) throw new Error(`Several styles are named "${ref}", use the ID`);
    found = by[0];
  }
  if (!found) throw new Error(`Style not found: "${ref}". Available: ${all.map((s) => s.name).join(", ") || "none"}`);
  return found;
}

function xSafe(v, depth) {
  if (v === figma.mixed) return "mixed";
  if (v === null || v === undefined || typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x) => xSafe(x, depth));
  if (typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = xSafe(v[k], depth); return o; }
  return String(v);
}
const X_RAW_KEYS = ["type", "name", "visible", "locked", "opacity", "blendMode", "isMask", "x", "y", "width", "height", "rotation", "fills", "strokes", "strokeWeight", "strokeAlign", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeJoin", "strokeCap", "dashPattern", "effects", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "cornerSmoothing", "clipsContent", "layoutMode", "layoutWrap", "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems", "counterAxisAlignContent", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "itemSpacing", "counterAxisSpacing", "itemReverseZIndex", "strokesIncludedInLayout", "layoutAlign", "layoutGrow", "layoutPositioning", "layoutSizingHorizontal", "layoutSizingVertical", "minWidth", "maxWidth", "minHeight", "maxHeight", "constraints", "layoutGrids", "fillStyleId", "strokeStyleId", "effectStyleId", "gridStyleId", "textStyleId", "characters", "fontName", "fontSize", "lineHeight", "letterSpacing", "textAutoResize", "textAlignHorizontal", "textAlignVertical", "textCase", "textDecoration", "textTruncation", "maxLines", "paragraphSpacing", "boundVariables", "reactions", "description", "componentPropertyDefinitions", "componentPropertyReferences", "componentProperties", "variantProperties", "variantGroupProperties", "booleanOperation"];
function xRaw(node, depth, keys) {
  const list = keys && keys.length ? keys : X_RAW_KEYS;
  const out = { id: node.id };
  for (const k of list) {
    if (!(k in node)) continue;
    try { out[k] = xSafe(node[k]); } catch (e) { out[k] = "(illisible)"; }
  }
  if ("children" in node) {
    if (depth > 0) out.children = node.children.map((c) => xRaw(c, depth - 1, keys));
    else out.childrenCount = node.children.length;
  }
  return out;
}

const X_COMMANDS = {
  async set_node_properties(p) {
    const node = await xNode(p.nodeId);
    await xApplyProps(node, p.properties);
    return { id: node.id, name: node.name, applied: Object.keys(p.properties) };
  },
  async bind_variable_field(p) {
    const node = await xNode(p.nodeId);
    const r = await xBindField(node, p.field, p.variableId);
    return Object.assign({ id: node.id, name: node.name, field: p.field }, r);
  },
  async set_paints(p) {
    const node = await xNode(p.nodeId);
    if (p.target !== "fills" && p.target !== "strokes") throw new Error("target must be fills or strokes");
    if (!(p.target in node)) throw new Error(`Node type ${node.type} has no ${p.target}`);
    if (!Array.isArray(p.paints) || p.paints.length > 8) throw new Error("paints must be a list of 8 paints at most");
    const paints = [];
    for (const x of p.paints) paints.push(await xBuildPaint(x));
    node[p.target] = paints;
    return { id: node.id, name: node.name, target: p.target, count: paints.length };
  },
  async set_effects(p) {
    const node = await xNode(p.nodeId);
    if (!("effects" in node)) throw new Error(`Node type ${node.type} has no effects`);
    node.effects = await xBuildEffects(p.effects);
    return { id: node.id, name: node.name, count: node.effects.length };
  },
  async create_effect_style(p) {
    if (!p.name || typeof p.name !== "string") throw new Error("Missing name parameter");
    if ((await figma.getLocalEffectStylesAsync()).some((s) => s.name === p.name)) throw new Error(`An effect style named "${p.name}" already exists`);
    const effects = await xBuildEffects(p.effects);
    const st = figma.createEffectStyle();
    st.name = p.name;
    st.effects = effects;
    return { id: st.id, name: st.name, count: effects.length };
  },
  async create_paint_style(p) {
    if (!p.name || typeof p.name !== "string") throw new Error("Missing name parameter");
    if ((await figma.getLocalPaintStylesAsync()).some((s) => s.name === p.name)) throw new Error(`A paint style named "${p.name}" already exists`);
    if (!Array.isArray(p.paints) || p.paints.length > 8) throw new Error("paints must be a list of 8 paints at most");
    const paints = [];
    for (const x of p.paints) paints.push(await xBuildPaint(x));
    const st = figma.createPaintStyle();
    st.name = p.name;
    st.paints = paints;
    return { id: st.id, name: st.name, count: paints.length };
  },
  async apply_style(p) {
    const node = await xNode(p.nodeId);
    const st = await xResolveStyle(p.kind, p.style);
    if (p.kind === "TEXT") { if (node.type !== "TEXT") throw new Error("TEXT style needs a text node"); if (st.fontName) await figma.loadFontAsync(st.fontName); await node.setTextStyleIdAsync(st.id); }
    else if (p.kind === "EFFECT") await node.setEffectStyleIdAsync(st.id);
    else if (p.kind === "FILL") await node.setFillStyleIdAsync(st.id);
    else if (p.kind === "STROKE") await node.setStrokeStyleIdAsync(st.id);
    else if (p.kind === "GRID") await node.setGridStyleIdAsync(st.id);
    return { id: node.id, name: node.name, styleId: st.id, styleName: st.name };
  },
  async delete_style(p) {
    const st = await figma.getStyleByIdAsync(p.styleId);
    if (!st) throw new Error(`Style not found: ${p.styleId}`);
    const name = st.name;
    st.remove();
    return { deleted: p.styleId, name };
  },
  async edit_text_style(p) {
    const st = await xResolveStyle("TEXT", p.style);
    if (p.fontFamily || p.fontStyle) {
      const fam = p.fontFamily || st.fontName.family, sty = p.fontStyle || st.fontName.style;
      await figma.loadFontAsync({ family: fam, style: sty });
      st.fontName = { family: fam, style: sty };
    } else await figma.loadFontAsync(st.fontName);
    if (p.fontSize !== undefined) st.fontSize = p.fontSize;
    const lhEdit = lmLineHeight(p);
    if (lhEdit !== undefined) st.lineHeight = lhEdit;
    if (p.letterSpacingPercent !== undefined) st.letterSpacing = { unit: "PERCENT", value: p.letterSpacingPercent };
    if (p.name) st.name = p.name;
    for (const [field, ref] of [["fontFamily", p.fontFamilyVariable], ["fontWeight", p.fontWeightVariable], ["fontSize", p.fontSizeVariable], ["lineHeight", p.lineHeightVariable], ["letterSpacing", p.letterSpacingVariable]]) {
      if (ref) st.setBoundVariable(field, await getVariableOrThrow(ref));
    }
    return { id: st.id, name: st.name, lineHeight: st.lineHeight };
  },
  async set_layout_grids(p) {
    const node = await xNode(p.nodeId);
    if (!("layoutGrids" in node)) throw new Error(`Node type ${node.type} has no layout grids`);
    if (!Array.isArray(p.grids) || p.grids.length > 8) throw new Error("grids must be a list of 8 grids at most");
    node.layoutGrids = p.grids.map((g) => {
      const color = g.color || { r: 1, g: 0, b: 0, a: 0.1 };
      if (g.pattern === "GRID") return { pattern: "GRID", sectionSize: g.sectionSize || 8, visible: g.visible !== false, color };
      if (g.pattern !== "COLUMNS" && g.pattern !== "ROWS") throw new Error("pattern must be GRID, COLUMNS or ROWS");
      // Figma rejects foreign keys: STRETCH takes offset (not sectionSize), CENTER takes sectionSize (not offset), MIN/MAX take both.
      const alignment = g.alignment || "STRETCH";
      const out = { pattern: g.pattern, alignment, gutterSize: g.gutterSize === undefined ? 24 : g.gutterSize, count: g.count === undefined ? 12 : g.count, visible: g.visible !== false, color };
      if (alignment === "STRETCH") out.offset = g.offset || 0;
      else if (alignment === "CENTER") out.sectionSize = g.sectionSize === undefined ? 100 : g.sectionSize;
      else { out.offset = g.offset || 0; out.sectionSize = g.sectionSize === undefined ? 100 : g.sectionSize; }
      return out;
    });
    return { id: node.id, name: node.name, count: node.layoutGrids.length };
  },

  // Variables
  async add_variable_mode(p) {
    const c = await xCollection(p.collection);
    const id = c.addMode(p.name);
    return { collection: c.name, modeId: id, name: p.name };
  },
  async rename_variable_mode(p) {
    const c = await xCollection(p.collection);
    c.renameMode(resolveModeId(c, p.mode), p.name);
    return { collection: c.name, name: p.name };
  },
  async remove_variable_mode(p) {
    const c = await xCollection(p.collection);
    c.removeMode(resolveModeId(c, p.mode));
    return { collection: c.name, removed: p.mode };
  },
  async rename_variable(p) {
    const v = await getVariableOrThrow(p.variableId);
    const before = v.name; v.name = p.name;
    return { id: v.id, before, name: v.name };
  },
  async delete_variable(p) {
    const v = await getVariableOrThrow(p.variableId);
    const name = v.name; v.remove();
    return { deleted: p.variableId, name };
  },
  async delete_variable_collection(p) {
    const c = await xCollection(p.collection);
    const name = c.name; c.remove();
    return { deleted: c.id, name };
  },
  async set_variable_alias(p) {
    const v = await getVariableOrThrow(p.variableId);
    const target = await getVariableOrThrow(p.aliasVariableId);
    const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
    v.setValueForMode(resolveModeId(c, p.mode), figma.variables.createVariableAlias(target));
    return { id: v.id, name: v.name, mode: p.mode, alias: target.name };
  },
  async set_variable_code_syntax(p) {
    const v = await getVariableOrThrow(p.variableId);
    v.setVariableCodeSyntax(p.platform, p.value);
    return { id: v.id, name: v.name, platform: p.platform, value: p.value };
  },
  async set_variable_publishing(p) {
    const v = await getVariableOrThrow(p.variableId);
    v.hiddenFromPublishing = !!p.hidden;
    return { id: v.id, name: v.name, hidden: v.hiddenFromPublishing };
  },

  // Composants
  async edit_component_property(p) {
    const node = await xNode(p.nodeId);
    const patch = {};
    if (p.name !== undefined) patch.name = p.name;
    if (p.defaultValue !== undefined) patch.defaultValue = p.defaultValue;
    const id = node.editComponentProperty(p.propertyId, patch);
    return { id: node.id, propertyId: id };
  },
  async delete_component_property(p) {
    const node = await xNode(p.nodeId);
    node.deleteComponentProperty(p.propertyId);
    return { id: node.id, deleted: p.propertyId };
  },
  async create_component(p) {
    const parent = await xParent(p.parentId);
    const c = figma.createComponent();
    parent.appendChild(c);
    c.name = p.name || "Component";
    if (p.x !== undefined) c.x = p.x;
    if (p.y !== undefined) c.y = p.y;
    if (p.width && p.height) c.resize(p.width, p.height);
    return { id: c.id, name: c.name };
  },
  async swap_instance(p) {
    const node = await xNode(p.nodeId);
    if (node.type !== "INSTANCE") throw new Error(`Node is not an INSTANCE (got ${node.type})`);
    const comp = await xNode(p.componentId);
    if (comp.type !== "COMPONENT") throw new Error(`Node ${p.componentId} is not a COMPONENT`);
    node.swapComponent(comp);
    return { id: node.id, name: node.name, componentId: comp.id };
  },
  async detach_instance(p) {
    const node = await xNode(p.nodeId);
    if (node.type !== "INSTANCE") throw new Error(`Node is not an INSTANCE (got ${node.type})`);
    const f = node.detachInstance();
    return { id: f.id, name: f.name, type: f.type };
  },
  async reset_instance_overrides(p) {
    const node = await xNode(p.nodeId);
    if (node.type !== "INSTANCE") throw new Error(`Node is not an INSTANCE (got ${node.type})`);
    node.resetOverrides();
    return { id: node.id, name: node.name };
  },

  // Pages et prototype
  async list_pages() {
    // Read-only, dynamic-page compatible: a page's id and name are readable without loading it.
    const pages = figma.root.children.filter((n) => n.type === "PAGE");
    return { count: pages.length, pages: pages.map((pg) => ({ id: pg.id, name: pg.name, isCurrent: pg.id === figma.currentPage.id })) };
  },
  async set_current_page(p) {
    const page = await xNode(p.pageId);
    if (page.type !== "PAGE") throw new Error("pageId must be a PAGE");
    await figma.setCurrentPageAsync(page);
    return { id: page.id, name: page.name };
  },
  async rename_page(p) {
    const page = await xNode(p.pageId);
    if (page.type !== "PAGE") throw new Error("pageId must be a PAGE");
    const before = page.name; page.name = p.name;
    return { id: page.id, before, name: page.name };
  },
  async delete_page(p) {
    const page = await xNode(p.pageId);
    if (page.type !== "PAGE") throw new Error("pageId must be a PAGE");
    if (figma.currentPage.id === page.id) throw new Error("Cannot delete the active page");
    if (figma.root.children.length < 2) throw new Error("Cannot delete the only page");
    const name = page.name; page.remove();
    return { deleted: p.pageId, name };
  },
  async set_reactions(p) {
    const node = await xNode(p.nodeId);
    if (!Array.isArray(p.reactions) || p.reactions.length > 20) throw new Error("reactions must be a list of 20 reactions at most");
    const TRIG = ["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG", "AFTER_TIMEOUT", "MOUSE_ENTER", "MOUSE_LEAVE", "MOUSE_UP", "MOUSE_DOWN"];
    const ACT = ["NODE", "BACK", "CLOSE", "URL"];
    for (const r of p.reactions) {
      if (!r || !r.trigger || !TRIG.includes(r.trigger.type)) throw new Error(`trigger.type must be one of ${TRIG.join(", ")}`);
      const acts = r.actions || (r.action ? [r.action] : []);
      for (const a of acts) if (!a || !ACT.includes(a.type)) throw new Error(`action.type must be one of ${ACT.join(", ")}`);
    }
    await node.setReactionsAsync(p.reactions.map((r) => ({ trigger: r.trigger, actions: r.actions || [r.action] })));
    return { id: node.id, name: node.name, count: p.reactions.length };
  },
  async set_flow_start(p) {
    const node = await xNode(p.nodeId);
    const flows = figma.currentPage.flowStartingPoints.filter((f) => f.nodeId !== node.id);
    flows.push({ nodeId: node.id, name: p.name || node.name });
    figma.currentPage.flowStartingPoints = flows;
    return { id: node.id, flows: flows.length };
  },
  async list_available_fonts(p) {
    const all = await figma.listAvailableFontsAsync();
    const q = (p && p.query ? String(p.query) : "").toLowerCase();
    const fams = {};
    for (const f of all) {
      if (q && !f.fontName.family.toLowerCase().includes(q)) continue;
      (fams[f.fontName.family] = fams[f.fontName.family] || []).push(f.fontName.style);
    }
    const names = Object.keys(fams).sort().slice(0, (p && p.limit) || 40);
    return names.map((n) => ({ family: n, styles: fams[n] }));
  },

  // Formes
  async create_ellipse(p) {
    const parent = await xParent(p.parentId);
    const e = figma.createEllipse();
    parent.appendChild(e);
    e.name = p.name || "Ellipse";
    if (p.x !== undefined) e.x = p.x;
    if (p.y !== undefined) e.y = p.y;
    e.resize(p.width || 100, p.height || 100);
    return { id: e.id, name: e.name };
  },
  async create_from_svg(p) {
    if (typeof p.svg !== "string" || p.svg.length > 200000) throw new Error("svg must be a string of 200000 characters at most");
    const parent = await xParent(p.parentId);
    let n = figma.createNodeFromSvg(p.svg);
    parent.appendChild(n);
    if (p.flatten) n = figma.flatten([n]);
    n.name = p.name || n.name;
    if (p.x !== undefined) n.x = p.x;
    if (p.y !== undefined) n.y = p.y;
    if (p.width && p.height) n.resize(p.width, p.height);
    return { id: n.id, name: n.name, type: n.type, width: n.width, height: n.height };
  },
  async boolean_operation(p) {
    const nodes = await xNodes(p.nodeIds, 2);
    const parent = await xParent(p.parentId, nodes[0].parent);
    const fn = { UNION: figma.union, SUBTRACT: figma.subtract, INTERSECT: figma.intersect, EXCLUDE: figma.exclude }[p.operation];
    if (!fn) throw new Error("operation must be UNION, SUBTRACT, INTERSECT or EXCLUDE");
    const r = fn.call(figma, nodes, parent);
    if (p.name) r.name = p.name;
    return { id: r.id, name: r.name };
  },
  async flatten_nodes(p) {
    const nodes = await xNodes(p.nodeIds);
    const r = figma.flatten(nodes);
    if (p.name) r.name = p.name;
    return { id: r.id, name: r.name };
  },
  async group_nodes(p) {
    const nodes = await xNodes(p.nodeIds);
    const parent = await xParent(p.parentId, nodes[0].parent);
    const g = figma.group(nodes, parent, p.index);
    if (p.name) g.name = p.name;
    return { id: g.id, name: g.name };
  },
  async ungroup_node(p) {
    const node = await xNode(p.nodeId);
    const kids = figma.ungroup(node);
    return { ids: kids.map((k) => k.id) };
  },

  // Text by range
  async set_text_range_style(p) {
    const node = await xNode(p.nodeId);
    if (node.type !== "TEXT") throw new Error("nodeId must be a text node");
    const len = node.characters.length;
    const start = p.start === undefined ? 0 : p.start, end = p.end === undefined ? len : p.end;
    if (!(start >= 0 && end <= len && start < end)) throw new Error(`range must satisfy 0 <= start < end <= ${len}`);
    await xLoadTextFonts(node);
    if (p.textStyle) {
      const st = await xResolveStyle("TEXT", p.textStyle);
      if (st.fontName) await figma.loadFontAsync(st.fontName);
      await node.setRangeTextStyleIdAsync(start, end, st.id);
    }
    if (p.fontFamily || p.fontStyle) {
      const cur = node.getRangeFontName(start, end);
      const fam = p.fontFamily || (cur !== figma.mixed ? cur.family : node.fontName.family);
      const sty = p.fontStyle || (cur !== figma.mixed ? cur.style : "Regular");
      await figma.loadFontAsync({ family: fam, style: sty });
      node.setRangeFontName(start, end, { family: fam, style: sty });
    }
    if (p.fontSize !== undefined) node.setRangeFontSize(start, end, p.fontSize);
    if (p.textDecoration) node.setRangeTextDecoration(start, end, p.textDecoration);
    if (p.textCase) node.setRangeTextCase(start, end, p.textCase);
    if (p.fillVariable) {
      const v = await getVariableOrThrow(p.fillVariable);
      const paint = figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", v);
      node.setRangeFills(start, end, [paint]);
    }
    if (p.hyperlink) node.setRangeHyperlink(start, end, { type: "URL", value: p.hyperlink });
    return { id: node.id, name: node.name, start, end };
  },

  // Full read
  async get_node_raw(p) {
    const node = await xNode(p.nodeId);
    const depth = Number.isInteger(p.depth) && p.depth >= 0 ? Math.min(p.depth, 10) : 0;
    return xRaw(node, depth, p.keys);
  },
};

// ---------------------------------------------------------------------------
// Batch measures: batch commands, time budget and resume by cursor.
// Every long read stops at its budget and returns { complete:false, nextCursor }:
// never a partial response without saying so.
// ---------------------------------------------------------------------------
const LM_DEFAULT_BUDGET = 60000;
function lmBudget(p) {
  const b = p && Number.isFinite(p.timeBudgetMs) ? p.timeBudgetMs : LM_DEFAULT_BUDGET;
  return Math.max(2000, Math.min(b, 100000));
}

// A single read of all local variables (instead of one call per variable).
async function lmLocalVariableMap() {
  const map = new Map();
  const list = await figma.variables.getLocalVariablesAsync();
  for (const v of list) map.set(v.id, v);
  return map;
}

// Variable name context: local first, library as fallback, memoized.
function lmVarContext(map) {
  const names = new Map();
  return {
    map,
    async info(id) {
      if (names.has(id)) return names.get(id);
      let v = map.get(id);
      if (!v) { try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) { v = null; } }
      const info = { id, name: v ? v.name : null };
      names.set(id, info);
      return info;
    },
  };
}

async function lmRoots(rootId) {
  if (rootId !== undefined && rootId !== null) {
    if (typeof rootId !== "string" || !rootId) throw new Error("rootId must be a node ID");
    const n = await figma.getNodeByIdAsync(rootId);
    if (!n) throw new Error(`Node not found with ID: ${rootId}`);
    return [n];
  }
  return Array.from(figma.root.children);
}

// Depth-first traversal, stable order. Instance children are excluded unless intoInstances.
// cursor = rank of the next node to visit; returns { complete, nextCursor, visited }.
async function lmTraverse(roots, o) {
  const st = { index: 0, stopped: false, visited: 0 };
  const cursor = Number.isInteger(o.cursor) && o.cursor > 0 ? o.cursor : 0;
  async function rec(node, depth) {
    if (st.stopped) return;
    if (o.skip && o.skip(node)) return;
    if (st.index >= cursor) {
      if (Date.now() > o.deadline || (o.stop && o.stop())) { st.stopped = true; return; }
      await o.visit(node, depth);
      st.visited++;
    }
    st.index++;
    if (node.type === "PAGE") await node.loadAsync();
    if (!("children" in node)) return;
    if (node.type === "INSTANCE" && !o.intoInstances) return;
    if (o.maxDepth !== undefined && depth >= o.maxDepth) return;
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) {
      await rec(kids[i], depth + 1);
      if (st.stopped) return;
    }
  }
  for (const r of roots) {
    await rec(r, 0);
    if (st.stopped) break;
  }
  return { complete: !st.stopped, nextCursor: st.stopped ? st.index : null, visited: st.visited };
}

function lmPositiveInt(v, def, max) {
  if (v === undefined || v === null) return def;
  if (!Number.isInteger(v) || v < 1) throw new Error("expected a positive integer");
  return Math.min(v, max);
}

// Links of a boundVariables field: alias, list of aliases or alias object.
function lmAliasFields(key, val, out) {
  if (!val) return;
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) if (val[i] && val[i].id) out.push({ field: key + "[" + i + "]", id: val[i].id });
  } else if (val.id) {
    out.push({ field: key, id: val.id });
  } else if (typeof val === "object") {
    for (const k of Object.keys(val)) lmAliasFields(key + "." + k, val[k], out);
  }
}

// All bindings of a node: boundVariables, then fill colors, strokes and effects.
function lmNodeAliases(node) {
  const out = [];
  const seen = new Set();
  function add(field, id) {
    const k = field + "|" + id;
    if (!seen.has(k)) { seen.add(k); out.push({ field, id }); }
  }
  const bv = node.boundVariables;
  if (bv) {
    const tmp = [];
    for (const key of Object.keys(bv)) lmAliasFields(key, bv[key], tmp);
    for (const t of tmp) add(t.field, t.id);
  }
  for (const key of ["fills", "strokes", "effects", "paints"]) {
    let list;
    try { list = node[key]; } catch (e) { list = null; }
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const pbv = list[i] && list[i].boundVariables;
      if (!pbv) continue;
      const tmp = [];
      for (const k of Object.keys(pbv)) lmAliasFields(key + "[" + i + "]" + (key === "effects" ? "." + k : ""), pbv[k], tmp);
      for (const t of tmp) add(t.field, t.id);
    }
  }
  return out;
}

const LM_TEXT_FIELDS = ["characters", "fontFamily", "fontStyle", "fontWeight", "fontSize", "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent"];
const LM_PAINT_FIELDS = ["fills", "strokes"];

function lmParseVariantName(name) {
  const out = {};
  String(name).split(",").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function lmBuildMatcher(select) {
  if (!select || typeof select !== "object" || Array.isArray(select)) throw new Error("select must be an object");
  const allowed = ["type", "nameEquals", "nameMatches", "variantProperties"];
  for (const k of Object.keys(select)) if (!allowed.includes(k)) throw new Error(`select.${k} is not supported (allowed: ${allowed.join(", ")})`);
  if (!allowed.some((k) => select[k] !== undefined)) throw new Error("select needs at least one criterion (type, nameEquals, nameMatches or variantProperties)");
  let re = null;
  if (select.nameMatches !== undefined) {
    if (typeof select.nameMatches !== "string" || !select.nameMatches || select.nameMatches.length > 200) throw new Error("select.nameMatches must be a regular expression of 200 characters at most");
    try { re = new RegExp(select.nameMatches); } catch (e) { throw new Error("select.nameMatches is not a valid regular expression"); }
  }
  if (select.type !== undefined && (typeof select.type !== "string" || !select.type)) throw new Error("select.type must be a node type such as FRAME, TEXT, COMPONENT, INSTANCE");
  if (select.nameEquals !== undefined && typeof select.nameEquals !== "string") throw new Error("select.nameEquals must be a string");
  const vp = select.variantProperties;
  if (vp !== undefined) {
    if (!vp || typeof vp !== "object" || Array.isArray(vp) || Object.keys(vp).length === 0) throw new Error("select.variantProperties must be a non-empty object such as {\"Taille\":\"Compact\"}");
    for (const k of Object.keys(vp)) if (typeof vp[k] !== "string") throw new Error("select.variantProperties values must be strings");
  }
  return function (node) {
    if (select.type !== undefined && node.type !== select.type) return false;
    if (select.nameEquals !== undefined && node.name !== select.nameEquals) return false;
    if (re && !re.test(node.name)) return false;
    if (vp !== undefined) {
      if (node.type !== "COMPONENT" && node.type !== "INSTANCE") return false;
      let props = null;
      try { props = node.variantProperties; } catch (e) { props = null; }
      if (!props && node.type === "COMPONENT") props = lmParseVariantName(node.name);
      if (!props) return false;
      for (const k of Object.keys(vp)) if (props[k] !== vp[k]) return false;
    }
    return true;
  };
}

async function lmLoadTextFonts(node) {
  if (node.type !== "TEXT") return;
  let names;
  try { names = node.fontName === figma.mixed ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName]; } catch (e) { return; }
  for (const f of names) { try { await figma.loadFontAsync(f); } catch (e) { /* reported by the binding itself */ } }
}

X_COMMANDS.bind_variable_batch = async function (p) {
  const deadline = Date.now() + lmBudget(p);
  if (!p.rootId || typeof p.rootId !== "string") throw new Error("Missing rootId parameter");
  const match = lmBuildMatcher(p.select);
  const where = lmParseWhere(p.where);
  if (!Array.isArray(p.bindings) || p.bindings.length < 1 || p.bindings.length > 12) throw new Error("bindings must be a list of 1 to 12 {field, variableId}");
  const dryRun = p.dryRun === true;
  const bindings = [];
  const seenFields = new Set();
  for (const b of p.bindings) {
    if (!b || typeof b !== "object") throw new Error("each binding must be {field, variableId}");
    if (!X_BIND_FIELDS.includes(b.field) && !LM_PAINT_FIELDS.includes(b.field)) throw new Error(`field must be one of ${X_BIND_FIELDS.concat(LM_PAINT_FIELDS).join(", ")}`);
    if (seenFields.has(b.field)) throw new Error(`field ${b.field} appears twice`);
    seenFields.add(b.field);
    let variable = null;
    if (b.variableId !== null && b.variableId !== undefined) {
      variable = await figma.variables.getVariableByIdAsync(b.variableId);
      if (!variable) throw new Error(`Variable not found with ID: ${b.variableId}`);
      if (LM_PAINT_FIELDS.includes(b.field) && variable.resolvedType !== "COLOR") throw new Error(`Variable ${variable.name} is ${variable.resolvedType}, a COLOR is needed for ${b.field}`);
    }
    bindings.push({ field: b.field, variable, variableName: variable ? variable.name : null });
  }
  const roots = await lmRoots(p.rootId);
  const maxNodes = lmPositiveInt(p.maxNodes, 5000, 20000);
  const res = { matched: 0, eligible: 0, nodesBound: 0, nodesFailed: 0, fieldsBound: 0, fieldsWouldBind: 0, failures: [], failuresTotal: 0, dryRun, matchedIds: [] };
  const FAIL_CAP = 200;
  function fail(node, field, error) {
    res.failuresTotal++;
    if (res.failures.length < FAIL_CAP) res.failures.push({ nodeId: node.id, name: node.name, field, error });
  }
  const t = await lmTraverse(roots, {
    cursor: p.cursor, deadline, intoInstances: p.includeInstanceChildren === true,
    stop: () => res.matched >= maxNodes,
    visit: async (node) => {
      if (!match(node)) return;
      res.matched++;
      // where: each binding is only applied if the control field (where.field, otherwise its own field) meets the criterion.
      const todo = where ? bindings.filter((b) => lmWhereScalar(where, node, where.field || b.field)) : bindings;
      if (todo.length === 0) return;
      res.eligible++;
      if (res.matchedIds.length < 500) res.matchedIds.push(node.id);
      if (dryRun) { res.fieldsWouldBind += todo.length; return; }
      let nodeFailed = false;
      for (const b of todo) {
        try {
          if (!(b.field in node)) { fail(node, b.field, `field missing on a ${node.type} node`); nodeFailed = true; continue; }
          if (LM_PAINT_FIELDS.includes(b.field)) {
            const paints = node[b.field];
            if (!Array.isArray(paints)) throw new Error(b.field + " is mixed or unreadable");
            let changed = 0;
            const np = paints.map((pt) => {
              if (pt.type !== "SOLID") return pt;
              if (where && !lmWherePaint(where, pt) && (where.field === undefined || where.field === b.field)) return pt;
              changed++;
              return figma.variables.setBoundVariableForPaint(pt, "color", b.variable);
            });
            if (!changed) throw new Error(where ? "no solid (SOLID) paint meets where" : "no solid (SOLID) paint to bind");
            node[b.field] = np;
          } else {
            if (LM_TEXT_FIELDS.includes(b.field)) await lmLoadTextFonts(node);
            node.setBoundVariable(b.field, b.variable);
          }
          res.fieldsBound++;
        } catch (e) {
          nodeFailed = true;
          fail(node, b.field, describeThrown(e, "bind_variable_batch"));
        }
      }
      if (nodeFailed) res.nodesFailed++; else res.nodesBound++;
    },
  });
  if (!dryRun) { delete res.matchedIds; delete res.fieldsWouldBind; } else res.matchedIdsNote = res.eligible > res.matchedIds.length ? `list truncated to ${res.matchedIds.length}` : undefined;
  res.complete = t.complete;
  res.nextCursor = t.nextCursor;
  res.visited = t.visited;
  res.bindings = bindings.map((b) => ({ field: b.field, variable: b.variableName }));
  return res;
};

X_COMMANDS.find_variable_usages = async function (p) {
  const deadline = Date.now() + lmBudget(p);
  if (!p.variableId || typeof p.variableId !== "string") throw new Error("Missing variableId parameter");
  const variable = await figma.variables.getVariableByIdAsync(p.variableId);
  if (!variable) throw new Error(`Variable not found with ID: ${p.variableId}`);
  const roots = await lmRoots(p.rootId);
  const max = lmPositiveInt(p.maxResults, 2000, 10000);
  const res = { variable: { id: variable.id, name: variable.name }, scope: p.rootId ? p.rootId : "all pages", usages: [] };
  const first = !(Number.isInteger(p.cursor) && p.cursor > 0);
  // On the first chunk: usages by other variables (aliases) and by local styles.
  if (first) {
    res.variableAliases = [];
    res.styles = [];
    try {
      const map = await lmLocalVariableMap();
      map.forEach((v) => {
        const vb = v.valuesByMode || {};
        for (const modeId of Object.keys(vb)) {
          const val = vb[modeId];
          if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS" && val.id === variable.id) res.variableAliases.push({ variableId: v.id, name: v.name, modeId });
        }
      });
    } catch (e) { res.variableAliasesError = describeThrown(e, "find_variable_usages"); }
    try {
      const lists = [await figma.getLocalTextStylesAsync(), await figma.getLocalPaintStylesAsync(), await figma.getLocalEffectStylesAsync(), await figma.getLocalGridStylesAsync()];
      for (const list of lists) for (const st of list) for (const a of lmNodeAliases(st)) if (a.id === variable.id) res.styles.push({ styleId: st.id, name: st.name, field: a.field });
    } catch (e) { res.stylesError = describeThrown(e, "find_variable_usages"); }
  }
  const t = await lmTraverse(roots, {
    cursor: p.cursor, deadline, intoInstances: p.includeInstanceChildren === true,
    stop: () => res.usages.length >= max,
    visit: async (node) => {
      for (const a of lmNodeAliases(node)) if (a.id === variable.id) res.usages.push({ nodeId: node.id, field: a.field });
    },
  });
  res.count = res.usages.length;
  res.complete = t.complete;
  res.nextCursor = t.nextCursor;
  res.visited = t.visited;
  res.instanceChildrenExcluded = p.includeInstanceChildren !== true;
  return res;
};

// ---------------------------------------------------------------------------
// where: filter by value or by current binding for bind_variable_batch.
// ---------------------------------------------------------------------------
const LM_WHERE_KEYS = ["field", "rawValue", "unbound", "boundTo"];

function lmParseWhere(where) {
  if (where === undefined || where === null) return null;
  if (typeof where !== "object" || Array.isArray(where)) throw new Error("where must be an object");
  for (const k of Object.keys(where)) if (!LM_WHERE_KEYS.includes(k)) throw new Error(`where.${k} is not supported (allowed: ${LM_WHERE_KEYS.join(", ")})`);
  const hasRaw = where.rawValue !== undefined, hasUnbound = where.unbound !== undefined, hasBound = where.boundTo !== undefined;
  if (!hasRaw && !hasUnbound && !hasBound) throw new Error("where needs at least one of rawValue, unbound, boundTo");
  if (hasUnbound && typeof where.unbound !== "boolean") throw new Error("where.unbound must be a boolean");
  if (hasBound && (typeof where.boundTo !== "string" || !where.boundTo)) throw new Error("where.boundTo must be a variable ID");
  if (where.unbound === true && hasBound) throw new Error("where.unbound:true and where.boundTo cannot be combined");
  if (hasRaw && !["number", "string", "boolean"].includes(typeof where.rawValue)) throw new Error("where.rawValue must be a number, a string or a boolean");
  if (where.field !== undefined && !X_BIND_FIELDS.includes(where.field) && !LM_PAINT_FIELDS.includes(where.field)) throw new Error(`where.field must be one of ${X_BIND_FIELDS.concat(LM_PAINT_FIELDS).join(", ")}`);
  return { field: where.field, hasRaw, rawValue: where.rawValue, unbound: where.unbound === true, boundTo: hasBound ? where.boundTo : null };
}

function lmSameNumber(a, b) { return typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.001; }

function lmRawEquals(actual, expected) {
  if (actual === figma.mixed) return false;
  if (typeof expected === "number") return lmSameNumber(actual, expected);
  return actual === expected;
}

function lmScalarAliasId(node, field) {
  const bv = node.boundVariables;
  const a = bv && bv[field];
  return a && a.id ? a.id : null;
}

// A color value written as text: #rgb, #rrggbb (case-insensitive).
function lmPaintHex(pt) {
  return pt.color ? lmHex(pt.color).toLowerCase() : null;
}

// True if the where criterion is met for a field of a node (scalar fields).
function lmWhereScalar(w, node, gateField) {
  if (!(gateField in node)) return false;
  if (LM_PAINT_FIELDS.includes(gateField)) return lmWherePaintsAny(w, node, gateField);
  const aliasId = lmScalarAliasId(node, gateField);
  if (w.unbound && aliasId) return false;
  if (w.boundTo && aliasId !== w.boundTo) return false;
  if (w.hasRaw) {
    let v;
    try { v = node[gateField]; } catch (e) { return false; }
    if (!lmRawEquals(v, w.rawValue)) return false;
  }
  return true;
}

// where criterion on a given paint.
function lmWherePaint(w, pt) {
  if (pt.type !== "SOLID") return false;
  const aliasId = pt.boundVariables && pt.boundVariables.color && pt.boundVariables.color.id;
  if (w.unbound && aliasId) return false;
  if (w.boundTo && aliasId !== w.boundTo) return false;
  if (w.hasRaw && lmPaintHex(pt) !== String(w.rawValue).toLowerCase()) return false;
  return true;
}

function lmWherePaintsAny(w, node, field) {
  let paints;
  try { paints = node[field]; } catch (e) { return false; }
  if (!Array.isArray(paints)) return false;
  return paints.some((pt) => lmWherePaint(w, pt));
}

const LM_EXTRA_FIELDS = ["cornerRadius", "layoutMode", "primaryAxisAlignItems", "counterAxisAlignItems", "layoutSizingHorizontal", "layoutSizingVertical", "layoutWrap", "strokeAlign", "textAutoResize", "fontName"];

function lmHex(c) {
  return rgbaToHex({ r: c.r, g: c.g, b: c.b, a: 1 });
}

async function lmPaintList(list, ctx) {
  if (list === figma.mixed) return "mixed";
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const pt of list) {
    const item = { type: pt.type };
    if (pt.visible === false) item.visible = false;
    if (typeof pt.opacity === "number" && pt.opacity !== 1) item.opacity = pt.opacity;
    if (pt.type === "SOLID" && pt.color) item.color = lmHex(pt.color);
    const alias = pt.boundVariables && pt.boundVariables.color;
    item.variable = alias && alias.id ? await ctx.info(alias.id) : null;
    out.push(item);
  }
  return out;
}

X_COMMANDS.get_nodes_bindings = async function (p) {
  const deadline = Date.now() + lmBudget(p);
  if (!p.rootId || typeof p.rootId !== "string") throw new Error("Missing rootId parameter");
  if (!Number.isInteger(p.depth) || p.depth < 0 || p.depth > 50) throw new Error("depth must be an integer from 0 to 50");
  let fields = p.fields === undefined ? [] : p.fields;
  if (!Array.isArray(fields) || fields.length > 40) throw new Error("fields must be a list of 40 field names at most");
  const allowed = X_BIND_FIELDS.concat(LM_EXTRA_FIELDS);
  for (const f of fields) if (!allowed.includes(f)) throw new Error(`field ${f} is not readable here (allowed: ${allowed.join(", ")})`);
  const filter = fields.length > 0;
  const readFields = filter ? fields : X_BIND_FIELDS.concat(LM_EXTRA_FIELDS);
  const maxNodes = lmPositiveInt(p.maxNodes, 500, 2000);
  const roots = await lmRoots(p.rootId);
  const ctx = lmVarContext(await lmLocalVariableMap());
  const nodes = [];
  const t = await lmTraverse(roots, {
    cursor: p.cursor, deadline, maxDepth: p.depth, intoInstances: false,
    stop: () => nodes.length >= maxNodes,
    visit: async (node, depth) => {
      const item = { id: node.id, name: node.name, type: node.type, depth, parentId: node.parent ? node.parent.id : null, values: {}, bindings: {} };
      for (const f of readFields) {
        if (!(f in node)) continue;
        let v;
        try { v = node[f]; } catch (e) { continue; }
        if (v === figma.mixed) v = "mixed";
        if (typeof v === "string" && v.length > 200) v = v.slice(0, 200) + "…";
        item.values[f] = v;
      }
      const all = lmNodeAliases(node);
      for (const a of all) {
        if (a.field.startsWith("fills") || a.field.startsWith("strokes") || a.field.startsWith("effects")) continue;
        const base = a.field.split("[")[0].split(".")[0];
        if (filter && !fields.includes(base)) continue;
        item.bindings[a.field] = await ctx.info(a.id);
      }
      if ("fills" in node) item.fills = await lmPaintList(node.fills, ctx);
      if ("strokes" in node) item.strokes = await lmPaintList(node.strokes, ctx);
      if (node.type === "INSTANCE") { item.instanceChildrenExcluded = true; item.childrenCount = node.children.length; }
      nodes.push(item);
    },
  });
  return { rootId: p.rootId, depth: p.depth, count: nodes.length, nodes, complete: t.complete, nextCursor: t.nextCursor, visited: t.visited };
};

// ---------------------------------------------------------------------------
// audit_bindings: the check of the default rules is computed in the plugin,
// only the reports come out. A report row: [nodeId, name, field, value, bound variable, rule].
// ---------------------------------------------------------------------------
const AB_RULES = ["unbound", "primitive", "not_multiple_of_4", "zero_padding", "height_not_in_set"];
const AB_HEIGHT_SET = [24, 32, 36, 44, 56, 64];
const AB_PADDING = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
const AB_NO_SIZE_TYPES = ["TEXT", "VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "POLYGON", "COMPONENT_SET", "SECTION", "PAGE", "SLICE", "GROUP"];
const AB_CONTAINER_TYPES = ["FRAME", "COMPONENT", "INSTANCE"];

function abRound(v) { return typeof v === "number" ? Math.round(v * 1000) / 1000 : v; }
function abIsMultipleOf4(v) { return Math.abs(v / 4 - Math.round(v / 4)) < 0.0005; }
function abHasVisibleFill(node) {
  let f; try { f = node.fills; } catch (e) { return false; }
  return Array.isArray(f) && f.some((x) => x.visible !== false && (x.opacity === undefined || x.opacity > 0));
}
function abHasVisibleStroke(node) {
  let s; try { s = node.strokes; } catch (e) { return false; }
  if (!Array.isArray(s) || !s.some((x) => x.visible !== false)) return false;
  let w = 0;
  try { w = node.strokeWeight === figma.mixed ? 1 : node.strokeWeight; } catch (e) { w = 1; }
  return w > 0;
}
function abFixedSize(node, axis) {
  if (AB_NO_SIZE_TYPES.includes(node.type)) return false;
  let m;
  try { m = axis === "height" ? node.layoutSizingVertical : node.layoutSizingHorizontal; } catch (e) { m = undefined; }
  return m === undefined || m === "FIXED";
}

X_COMMANDS.audit_bindings = async function (p) {
  const deadline = Date.now() + lmBudget(p);
  if (!p.rootId || typeof p.rootId !== "string") throw new Error("Missing rootId parameter");
  let rules = p.rules === undefined ? AB_RULES.slice() : p.rules;
  if (!Array.isArray(rules) || rules.length === 0) throw new Error(`rules must be a non-empty list among ${AB_RULES.join(", ")}`);
  for (const r of rules) if (!AB_RULES.includes(r)) throw new Error(`rule ${r} is unknown (allowed: ${AB_RULES.join(", ")})`);
  rules = Array.from(new Set(rules));
  const on = {}; for (const r of rules) on[r] = true;
  const maxResults = p.maxResults === undefined ? 200 : p.maxResults;
  if (!Number.isInteger(maxResults) || maxResults < 0 || maxResults > 5000) throw new Error("maxResults must be an integer from 0 to 5000 (0 = counts only)");
  const heightSet = p.heightSet === undefined ? AB_HEIGHT_SET : p.heightSet;
  if (!Array.isArray(heightSet) || heightSet.length < 1 || heightSet.length > 30 || !heightSet.every((n) => typeof n === "number")) throw new Error("heightSet must be a list of numbers");
  const heightScope = p.heightScope === undefined ? "components" : p.heightScope;
  if (heightScope !== "components" && heightScope !== "all") throw new Error('heightScope must be "components" or "all"');
  const roots = await lmRoots(p.rootId);
  const excludeInstanceChildren = p.excludeInstanceChildren !== false;

  const map = await lmLocalVariableMap();
  const ctx = lmVarContext(map);
  const collName = p.primitiveCollection === undefined ? "Primitives" : p.primitiveCollection;
  const primitiveIds = new Set();
  if (on.primitive) {
    if (typeof collName !== "string" || !collName) throw new Error("primitiveCollection must be a collection name");
    const colls = await figma.variables.getLocalVariableCollectionsAsync();
    const hit = colls.filter((c) => c.name.toLowerCase() === collName.toLowerCase());
    if (hit.length === 0) throw new Error(`Variable collection "${collName}" not found (existing: ${colls.map((c) => c.name).join(", ")})`);
    const ids = new Set(hit.map((c) => c.id));
    map.forEach((v) => { if (ids.has(v.variableCollectionId)) primitiveIds.add(v.id); });
  }

  const totals = {}; for (const r of rules) totals[r] = 0;
  const rows = [];
  const countOnly = maxResults === 0;

  async function varName(id) { return id ? (await ctx.info(id)).name : null; }
  async function report(node, rule, field, value, aliasId) {
    totals[rule]++;
    if (countOnly) return;
    rows.push([node.id, node.name, field, abRound(value), await varName(aliasId), rule]);
  }

  // Readable value of a numeric field; null if mixed or missing.
  function num(node, f) {
    if (!(f in node)) return null;
    let v; try { v = node[f]; } catch (e) { return null; }
    return typeof v === "number" ? v : null;
  }

  const t = await lmTraverse(roots, {
    cursor: p.cursor, deadline, intoInstances: !excludeInstanceChildren,
    stop: () => !countOnly && rows.length >= maxResults,
    visit: async (node) => {
      if (node.type === "PAGE") return;
      const isContainer = AB_CONTAINER_TYPES.includes(node.type);
      const auto = isContainer && node.layoutMode && node.layoutMode !== "NONE";
      // Numeric fields concerned: [field, value, relevant for "no variable", relevant for "multiple of 4"].
      const measured = [];
      if (auto) {
        const kids = node.children.filter((c) => c.visible !== false && c.layoutPositioning !== "ABSOLUTE");
        const spaceBetween = node.primaryAxisAlignItems === "SPACE_BETWEEN";
        const gap = num(node, "itemSpacing");
        if (gap !== null && kids.length >= 2 && !spaceBetween) measured.push(["itemSpacing", gap, true, true, gap === 0]);
        if (node.layoutWrap === "WRAP") { const cg = num(node, "counterAxisSpacing"); if (cg !== null) measured.push(["counterAxisSpacing", cg, true, true, cg === 0]); }
        for (const f of AB_PADDING) { const v = num(node, f); if (v !== null) measured.push([f, v, v !== 0, true, false]); }
      }
      if ("width" in node && abFixedSize(node, "width")) { const v = num(node, "width"); if (v !== null) measured.push(["width", v, true, true, false]); }
      if ("height" in node && abFixedSize(node, "height")) { const v = num(node, "height"); if (v !== null) measured.push(["height", v, true, true, false]); }
      for (const [field, value, wantUnbound, wantMultiple, zeroGap] of measured) {
        const aliasId = lmScalarAliasId(node, field);
        if (on.unbound && !aliasId && (wantUnbound || zeroGap)) await report(node, "unbound", field, value, null);
        if (on.primitive && aliasId && primitiveIds.has(aliasId)) await report(node, "primitive", field, value, aliasId);
        // A stroke (width or height of 1 to 3, separator) is outside the multiple-of-4 rule.
        const isTrait = (field === "width" || field === "height") && value > 0 && value <= 3;
        if (on.not_multiple_of_4 && wantMultiple && !isTrait && !abIsMultipleOf4(value)) await report(node, "not_multiple_of_4", field, value, aliasId);
      }
      // Radii and strokes: no variable and primitive only (outside the multiple-of-4 rule).
      if (on.unbound || on.primitive) {
        if ("topLeftRadius" in node) {
          // Four identical corners (same value, same binding): a single "cornerRadius" report.
          const RF = ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"];
          const vals = RF.map((f) => num(node, f));
          const ids = RF.map((f) => lmScalarAliasId(node, f));
          const same = vals[0] !== null && vals.every((v) => v === vals[0]) && ids.every((i) => i === ids[0]);
          const list = same ? [["cornerRadius", vals[0], ids[0]]] : RF.map((f, i) => [f, vals[i], ids[i]]);
          for (const [f, v, aliasId] of list) {
            if (v === null) continue;
            if (on.unbound && !aliasId && (v !== 0 || p.includeZeroRadius === true)) await report(node, "unbound", f, v, null);
            if (on.primitive && aliasId && primitiveIds.has(aliasId)) await report(node, "primitive", f, v, aliasId);
          }
        }
        if ("strokeWeight" in node && abHasVisibleStroke(node)) {
          // Uniform thickness: a single report; mixed: the four sides.
          const uniform = num(node, "strokeWeight") !== null;
          const fs = uniform ? ["strokeWeight"] : ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];
          for (const f of fs) {
            const v = num(node, f); if (v === null) continue;
            const aliasId = lmScalarAliasId(node, f);
            if (on.unbound && !aliasId && v > 0) await report(node, "unbound", f, v, null);
            if (on.primitive && aliasId && primitiveIds.has(aliasId)) await report(node, "primitive", f, v, aliasId);
          }
        }
      }
      // Colors: solid paints without variable; paint bindings to a primitive.
      if (on.unbound || on.primitive) {
        for (const key of ["fills", "strokes"]) {
          if (!(key in node)) continue;
          let list; try { list = node[key]; } catch (e) { continue; }
          if (!Array.isArray(list)) continue;
          for (let i = 0; i < list.length; i++) {
            const pt = list[i];
            if (pt.type !== "SOLID" || pt.visible === false) continue;
            const alias = pt.boundVariables && pt.boundVariables.color;
            const aliasId = alias && alias.id ? alias.id : null;
            if (on.unbound && !aliasId) await report(node, "unbound", `${key}[${i}]`, lmPaintHex(pt), null);
            if (on.primitive && aliasId && primitiveIds.has(aliasId)) await report(node, "primitive", `${key}[${i}]`, lmPaintHex(pt), aliasId);
          }
        }
      }
      // Text: missing text style; line height in pixels multiple of 4; text bindings to a primitive.
      if (node.type === "TEXT") {
        let styleId = ""; try { styleId = node.textStyleId; } catch (e) { styleId = ""; }
        if (on.unbound && styleId === "") await report(node, "unbound", "textStyle", null, null);
        if (on.not_multiple_of_4) {
          let lh = null; try { lh = node.lineHeight; } catch (e) { lh = null; }
          if (lh && lh !== figma.mixed && lh.unit === "PIXELS" && !abIsMultipleOf4(lh.value)) await report(node, "not_multiple_of_4", "lineHeight", lh.value, lmScalarAliasId(node, "lineHeight"));
        }
        if (on.primitive) {
          for (const f of ["fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent"]) {
            const aliasId = lmScalarAliasId(node, f);
            if (aliasId && primitiveIds.has(aliasId)) await report(node, "primitive", f, num(node, f), aliasId);
          }
        }
      }
      // Padding at 0 on a frame that has a fill or a stroke (and content to keep away from the edge).
      if (on.zero_padding && auto && node.children.length > 0 && (abHasVisibleFill(node) || abHasVisibleStroke(node))) {
        for (const f of AB_PADDING) {
          const v = num(node, f);
          if (v === 0) await report(node, "zero_padding", f, 0, lmScalarAliasId(node, f));
        }
      }
      // Height outside the closed set: components and nodes whose height is bound, or all (heightScope all).
      if (on.height_not_in_set && "height" in node && !AB_NO_SIZE_TYPES.includes(node.type)) {
        const h = num(node, "height");
        if (h !== null) {
          const aliasId = lmScalarAliasId(node, "height");
          const inScope = heightScope === "all" || node.type === "COMPONENT" || !!aliasId;
          if (inScope && !heightSet.some((s) => Math.abs(s - h) < 0.0005)) await report(node, "height_not_in_set", "height", h, aliasId);
        }
      }
    },
  });
  const res = {
    rootId: p.rootId, rules, totals, count: rows.length,
    columns: ["nodeId", "name", "field", "value", "variable", "rule"],
    findings: rows,
    complete: t.complete, nextCursor: t.nextCursor, visited: t.visited,
    instanceChildrenExcluded: excludeInstanceChildren,
    scope: heightScope,
  };
  if (!t.complete && rows.length >= maxResults && !countOnly) res.stoppedBecause = Date.now() > deadline ? "time budget" : "maxResults";
  res.totalsNote = "totals count the nodes visited by this call only; add them up across calls when partial";
  return res;
};

// rebind_variable_usages: replaces a binding everywhere with another (same variable type).
const RB_SCALAR_NOTE = "variable-to-variable aliases, styles and text ranges untouched (see find_variable_usages)";

X_COMMANDS.rebind_variable_usages = async function (p) {
  const deadline = Date.now() + lmBudget(p);
  if (!p.fromVariableId || typeof p.fromVariableId !== "string") throw new Error("Missing fromVariableId parameter");
  if (!p.toVariableId || typeof p.toVariableId !== "string") throw new Error("Missing toVariableId parameter");
  if (p.fromVariableId === p.toVariableId) throw new Error("fromVariableId and toVariableId are the same variable");
  if (typeof p.dryRun !== "boolean") throw new Error("dryRun is required (true to count without writing, false to write)");
  const from = await figma.variables.getVariableByIdAsync(p.fromVariableId);
  if (!from) throw new Error(`Variable not found with ID: ${p.fromVariableId}`);
  const to = await figma.variables.getVariableByIdAsync(p.toVariableId);
  if (!to) throw new Error(`Variable not found with ID: ${p.toVariableId}`);
  if (from.resolvedType !== to.resolvedType) throw new Error(`Variable types differ: ${from.name} is ${from.resolvedType}, ${to.name} is ${to.resolvedType}`);
  let fields = p.fields;
  if (fields !== undefined) {
    if (!Array.isArray(fields) || fields.length === 0 || fields.length > 40) throw new Error("fields must be a list of 1 to 40 field names");
    for (const f of fields) if (!X_BIND_FIELDS.includes(f) && !LM_PAINT_FIELDS.includes(f) && f !== "effects") throw new Error(`field ${f} is not supported (allowed: ${X_BIND_FIELDS.concat(LM_PAINT_FIELDS, ["effects"]).join(", ")})`);
  }
  const wanted = (base) => !fields || fields.includes(base);
  const roots = await lmRoots(p.rootId);
  const maxNodes = lmPositiveInt(p.maxNodes, 20000, 50000);
  const dryRun = p.dryRun;
  const res = { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, scope: p.rootId ? p.rootId : "all pages", dryRun, nodesChanged: 0, bindingsChanged: 0, byField: {}, failures: [], failuresTotal: 0, sample: [] };
  const FAIL_CAP = 200;
  function fail(node, field, error) {
    res.failuresTotal++;
    if (res.failures.length < FAIL_CAP) res.failures.push({ nodeId: node.id, name: node.name, field, error });
  }
  function changed(node, field) {
    res.bindingsChanged++;
    const base = field.split("[")[0].split(".")[0];
    res.byField[base] = (res.byField[base] || 0) + 1;
    if (res.sample.length < 20) res.sample.push([node.id, field]);
  }
  let touched = 0;
  const t = await lmTraverse(roots, {
    cursor: p.cursor, deadline, intoInstances: p.includeInstanceChildren === true,
    stop: () => touched >= maxNodes,
    visit: async (node) => {
      let any = false;
      const bv = node.boundVariables;
      // Champs scalaires.
      if (bv) {
        for (const f of X_BIND_FIELDS) {
          if (!wanted(f)) continue;
          if (lmScalarAliasId(node, f) !== from.id) continue;
          any = true;
          if (dryRun) { changed(node, f); continue; }
          try {
            if (LM_TEXT_FIELDS.includes(f)) await lmLoadTextFonts(node);
            node.setBoundVariable(f, to);
            changed(node, f);
          } catch (e) { fail(node, f, describeThrown(e, "rebind_variable_usages")); }
        }
      }
      // Paints (fills, strokes): color of each paint bound to from.
      for (const key of LM_PAINT_FIELDS) {
        if (!wanted(key) || !(key in node)) continue;
        let list; try { list = node[key]; } catch (e) { continue; }
        if (!Array.isArray(list)) continue;
        const hits = [];
        list.forEach((pt, i) => { const a = pt.boundVariables && pt.boundVariables.color; if (a && a.id === from.id) hits.push(i); });
        if (!hits.length) continue;
        any = true;
        if (dryRun) { hits.forEach((i) => changed(node, `${key}[${i}]`)); continue; }
        try {
          const np = list.map((pt, i) => hits.includes(i) ? figma.variables.setBoundVariableForPaint(pt, "color", to) : pt);
          node[key] = np;
          hits.forEach((i) => changed(node, `${key}[${i}]`));
        } catch (e) { fail(node, key, describeThrown(e, "rebind_variable_usages")); }
      }
      // Effects (color, radius, offsets) bound to from.
      if (wanted("effects") && "effects" in node) {
        let list; try { list = node.effects; } catch (e) { list = null; }
        if (Array.isArray(list)) {
          const hits = [];
          list.forEach((ef, i) => { const eb = ef.boundVariables; if (eb) for (const k of Object.keys(eb)) { const a = eb[k]; if (a && a.id === from.id) hits.push([i, k]); } });
          if (hits.length) {
            any = true;
            if (dryRun) hits.forEach(([i, k]) => changed(node, `effects[${i}].${k}`));
            else {
              try {
                const ne = list.slice();
                for (const [i, k] of hits) ne[i] = figma.variables.setBoundVariableForEffect(ne[i], k, to);
                node.effects = ne;
                hits.forEach(([i, k]) => changed(node, `effects[${i}].${k}`));
              } catch (e) { fail(node, "effects", describeThrown(e, "rebind_variable_usages")); }
            }
          }
        }
      }
      if (any) { touched++; res.nodesChanged++; }
    },
  });
  res.complete = t.complete;
  res.nextCursor = t.nextCursor;
  res.visited = t.visited;
  res.instanceChildrenExcluded = p.includeInstanceChildren !== true;
  res.note = RB_SCALAR_NOTE + "; counts are per call, add them up when partial";
  return res;
};

// scan_text_nodes: read-only, with time budget and resume. The old version highlighted
// each text (write + 500 ms pause per node); highlighting now only exists on request.
X_COMMANDS.scan_text_nodes = async function (p) {
  const deadline = Date.now() + lmBudget(p);
  if (!p.nodeId || typeof p.nodeId !== "string") throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error(`Node with ID ${p.nodeId} not found`);
  const maxNodes = lmPositiveInt(p.maxNodes, 1000, 5000);
  const highlight = p.highlight === true;
  const textNodes = [];
  const t = await lmTraverse([node], {
    cursor: p.cursor, deadline, intoInstances: p.includeInstanceChildren !== false,
    skip: (n) => n.visible === false,
    stop: () => textNodes.length >= maxNodes,
    visit: async (n, depth) => {
      if (n.type !== "TEXT") return;
      const fn = n.fontName && typeof n.fontName === "object" && "family" in n.fontName ? n.fontName : { family: "", style: "" };
      textNodes.push({
        id: n.id, name: n.name || "Text", type: n.type, characters: n.characters,
        fontSize: typeof n.fontSize === "number" ? n.fontSize : 0,
        fontFamily: fn.family || "", fontStyle: fn.style || "",
        x: typeof n.x === "number" ? n.x : 0, y: typeof n.y === "number" ? n.y : 0,
        width: typeof n.width === "number" ? n.width : 0, height: typeof n.height === "number" ? n.height : 0,
        path: lmPathFrom(n, node), depth,
      });
      if (highlight) {
        try {
          const original = JSON.parse(JSON.stringify(n.fills));
          n.fills = [{ type: "SOLID", color: { r: 1, g: 0.5, b: 0 }, opacity: 0.3 }];
          await delay(300);
          n.fills = original;
        } catch (e) { /* surlignage facultatif */ }
      }
    },
  });
  return {
    success: true,
    message: `Scanned ${textNodes.length} text nodes${t.complete ? "" : " (partial: see nextCursor)"}.`,
    count: textNodes.length, textNodes, complete: t.complete, nextCursor: t.nextCursor, visited: t.visited,
  };
};

// Path "A > B > C" of the node from the traversal root (like the old version).
function lmPathFrom(n, root) {
  const names = [];
  let cur = n;
  while (cur) {
    names.unshift(cur.name || `Unnamed ${cur.type}`);
    if (cur.id === root.id) break;
    cur = cur.parent;
  }
  return names.join(" > ");
}

// Line height: { unit: "PIXELS" | "PERCENT", value } or { unit: "AUTO" }; lineHeightPercent is still accepted.
function lmLineHeight(p) {
  if (p.lineHeight !== undefined && p.lineHeightPercent !== undefined) throw new Error("Give lineHeight or lineHeightPercent, not both");
  if (p.lineHeight === undefined) return p.lineHeightPercent !== undefined ? { unit: "PERCENT", value: p.lineHeightPercent } : undefined;
  const lh = p.lineHeight;
  if (!lh || typeof lh !== "object" || !["PIXELS", "PERCENT", "AUTO"].includes(lh.unit)) throw new Error("lineHeight must be { unit: PIXELS | PERCENT | AUTO, value? }");
  if (lh.unit === "AUTO") {
    if (lh.value !== undefined) throw new Error("lineHeight AUTO takes no value");
    return { unit: "AUTO" };
  }
  if (typeof lh.value !== "number" || !Number.isFinite(lh.value) || lh.value <= 0) throw new Error("lineHeight.value must be a positive number for PIXELS or PERCENT");
  return { unit: lh.unit, value: lh.value };
}
