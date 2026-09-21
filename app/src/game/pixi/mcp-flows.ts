import { Container, Graphics, Text } from "pixi.js";
import { flowColor, FLOW_TTL_MS, type McpFlow } from "../state/mcp-flows";
import type { Actor } from "../world/sim";
import { toScreen } from "../world/iso";

/** Static directed paths: no invented source actor and no motion requirement. */
export class McpFlowLayer {
  private layer = new Container();
  private paths = new Graphics();
  private source = new Text({text:"External MCP client", style:{fontFamily:"sans-serif",fontSize:20,fill:0xffffff,stroke:{color:0x15212c,width:4}}});
  private destroyed = false;

  constructor(parent: Container) {
    this.layer.eventMode = "none";
    this.layer.addChild(this.paths, this.source);
    parent.addChild(this.layer);
  }

  sync(flows:readonly McpFlow[], actors:readonly Actor[], now:number):void {
    if (this.destroyed) return;
    /*
     * Only observations that have, at this moment, a real figure on this field
     * get a path. A flow whose target is not drawn is not pointed at, and no
     * stand-in sender is ever drawn: the marker is a neutral client, not an
     * actor invented to make the picture symmetrical.
     */
    const paths = flows.filter(flow => now-flow.at < FLOW_TTL_MS)
      .slice(0,8).map(flow => ({flow,target:actors.find(actor => actor.session?.id === flow.targetSessionId)}))
      .filter((item): item is {flow:McpFlow; target:Actor} => item.target !== undefined);
    this.layer.visible = paths.length > 0;
    this.paths.clear();
    if (!paths.length) return;
    // A neutral marker above the first observed target, not another session.
    const first = toScreen(paths[0].target.x, paths[0].target.y);
    const from = {x:first.x-170,y:first.y-170};
    this.source.position.set(from.x-90,from.y-30);
    this.paths.circle(from.x,from.y,8).fill(0x89dceb);
    for (const {flow,target} of paths) {
      const to = toScreen(target.x,target.y);
      const angle = Math.atan2(to.y-from.y,to.x-from.x);
      const color = flowColor(flow);
      this.paths.moveTo(from.x,from.y).lineTo(to.x,to.y).stroke({width:3,color,alpha:0.8});
      this.paths.moveTo(to.x-14*Math.cos(angle-0.45),to.y-14*Math.sin(angle-0.45))
        .lineTo(to.x,to.y).lineTo(to.x-14*Math.cos(angle+0.45),to.y-14*Math.sin(angle+0.45))
        .stroke({width:3,color});
    }
  }

  destroy():void {
    this.destroyed = true;
    this.layer.destroy({children:true});
  }
}
