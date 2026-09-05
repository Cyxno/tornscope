<script lang="ts">
  import { onMount } from "svelte";

  /**
   * Reusable ECharts wrapper: initializes once, applies option updates,
   * and resizes with its container. Tree-shaken chart modules are
   * registered here so every page gets the same lean bundle.
   */
  let { option, height = 320 }: { option: Record<string, unknown>; height?: number } = $props();

  let container: HTMLDivElement | undefined = $state();
  let chart: import("echarts/core").ECharts | null = null;

  onMount(async () => {
    const echarts = await import("echarts/core");
    const { LineChart, BarChart, PieChart } = await import("echarts/charts");
    const { GridComponent, TooltipComponent, DataZoomComponent, LegendComponent, TitleComponent } = await import("echarts/components");
    const { CanvasRenderer } = await import("echarts/renderers");

    echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, DataZoomComponent, LegendComponent, TitleComponent, CanvasRenderer]);

    if (!container) return;
    chart = echarts.init(container);
    chart.setOption(option);

    const observer = new ResizeObserver(() => chart?.resize());
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart?.dispose();
      chart = null;
    };
  });

  $effect(() => {
    const current = $state.snapshot(option);
    if (chart) chart.setOption(current, { notMerge: false });
  });
</script>

<div bind:this={container} style="width: 100%; height: {height}px"></div>
