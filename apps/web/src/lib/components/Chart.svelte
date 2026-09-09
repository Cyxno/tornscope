<script lang="ts">
  import { onMount } from "svelte";

  /**
   * Reusable ECharts wrapper: initializes once, applies option updates,
   * and resizes with its container. Tree-shaken chart modules are
   * registered here so every page gets the same lean bundle.
   *
   * Resize robustness: ResizeObserver alone can miss a shrink on mobile
   * (observed on iOS Safari around rotation/address-bar changes). A missed
   * shrink leaves the canvas at its old pixel width, which then stretches
   * the whole page horizontally. The window resize listener is a second
   * trigger, and the container clips its own overflow so a stale canvas
   * can never widen the page even if both miss.
   */
  let { option, height = 320 }: { option: Record<string, unknown>; height?: number } = $props();

  let container: HTMLDivElement | undefined = $state();
  let chart: import("echarts/core").ECharts | null = null;

  onMount(() => {
    let observer: ResizeObserver | null = null;
    let disposed = false;
    const onWindowResize = () => chart?.resize();

    void (async () => {
      const echarts = await import("echarts/core");
      const { LineChart, BarChart, PieChart } = await import("echarts/charts");
      const { GridComponent, TooltipComponent, DataZoomComponent, LegendComponent, TitleComponent } = await import("echarts/components");
      const { CanvasRenderer } = await import("echarts/renderers");

      echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, DataZoomComponent, LegendComponent, TitleComponent, CanvasRenderer]);

      if (disposed || !container) return;
      chart = echarts.init(container);
      chart.setOption(withMotion(option));

      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(container);
      window.addEventListener("resize", onWindowResize);
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", onWindowResize);
      chart?.dispose();
      chart = null;
    };
  });

  // Honor prefers-reduced-motion: charts render instantly, no transitions.
  function withMotion(opt: Record<string, unknown>): Record<string, unknown> {
    if (typeof window === "undefined" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches) return opt;
    return { ...opt, animation: false, animationDurationUpdate: 0 };
  }

  $effect(() => {
    const current = $state.snapshot(option);
    if (chart) chart.setOption(withMotion(current), { notMerge: false });
  });
</script>

<div bind:this={container} class="min-w-0 max-w-full overflow-hidden" style="width: 100%; height: {height}px; contain: inline-size;"></div>

<style>
  /* ECharts writes an inline px width on the canvas. If the canvas ever ends
     up wider than its container (a resize missed on mobile, e.g. across a
     rotation), that px width feeds the page's intrinsic sizing — grid auto
     tracks and block chains keep the container as wide as the canvas, and
     the whole page stays stretched. contain: inline-size cuts the intrinsic
     contribution here, so the container always tracks its parent's width
     and a stale canvas can only be clipped, never widen the page. */
  div :global(canvas) {
    max-width: 100%;
  }
</style>
