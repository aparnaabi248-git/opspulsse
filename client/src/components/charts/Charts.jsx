import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { useTheme } from '../../context/ThemeContext';
import { CHART_COLORS } from '../../utils/status';
import { formatMs, formatTime, formatDateTime } from '../../utils/format';

/**
 * Chart building blocks.
 *
 * IMPORTANT: gaps in the data (buckets with no recorded check) arrive as
 * `null`. Recharts is configured with connectNulls={false} so it draws a gap
 * instead of inventing a straight line through missing data.
 */

const useChartTheme = () => {
  const { theme } = useTheme();
  const grid = theme === 'dark' ? '#1e293b' : '#e8edf5';
  const text = theme === 'dark' ? '#94a3b8' : '#475569';
  return { grid, text, tooltipBg: theme === 'dark' ? '#111827' : '#ffffff', border: theme === 'dark' ? '#33415c' : '#e2e8f0' };
};

function BaseTooltip({ active, payload, label, formatter, rangeLabel }) {
  const { tooltipBg, border, text } = useChartTheme();
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div
      style={{
        background: tooltipBg,
        border: `1px solid ${border}`,
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
      }}
    >
      <div style={{ color: text, marginBottom: 4, fontWeight: 600 }}>
        {rangeLabel === 'day' ? formatDateTime(label) : formatTime(label)}
      </div>
      {payload
        .filter((p) => p.value !== null && p.value !== undefined)
        .map((p) => (
          <div key={p.dataKey} style={{ color: p.color || p.stroke, display: 'flex', gap: 8, justifyContent: 'space-between' }}>
            <span>{p.name}</span>
            <strong>{formatter ? formatter(p) : p.value}</strong>
          </div>
        ))}
      {payload.every((p) => p.value === null) && (
        <div style={{ color: text }}>No checks recorded in this period</div>
      )}
    </div>
  );
}

const axisProps = (grid, text) => ({
  stroke: grid,
  tick: { fill: text, fontSize: 11 },
  tickLine: false,
});

/** Average response time over time. Gaps stay gaps. */
export function ResponseTimeChart({ data, height = 280, rangeLabel = 'time', unit = 'ms' }) {
  const { grid, text } = useChartTheme();

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="rtFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_COLORS.brand} stopOpacity={0.34} />
            <stop offset="100%" stopColor={CHART_COLORS.brand} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" {...axisProps(grid, text)} vertical={false} />
        <XAxis dataKey="at" {...axisProps(grid, text)} tickFormatter={(v) => formatTime(v)} minTickGap={28} />
        <YAxis {...axisProps(grid, text)} tickFormatter={(v) => (unit === 'ms' ? `${v}` : `${v}%`)} width={48} />
        <Tooltip
          content={<BaseTooltip rangeLabel={rangeLabel} formatter={(p) => formatMs(p.value)} />}
        />
        <Area
          type="monotone"
          dataKey="avgResponseTime"
          name="Average response"
          stroke={CHART_COLORS.brand}
          strokeWidth={2}
          fill="url(#rtFill)"
          connectNulls={false}
          dot={false}
          activeDot={{ r: 4 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Response time spread: average plus min/max envelope. */
export function ResponseTimeRangeChart({ data, height = 260 }) {
  const { grid, text } = useChartTheme();

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" {...axisProps(grid, text)} vertical={false} />
        <XAxis dataKey="at" {...axisProps(grid, text)} tickFormatter={(v) => formatTime(v)} minTickGap={28} />
        <YAxis {...axisProps(grid, text)} tickFormatter={(v) => `${v}`} width={48} />
        <Tooltip content={<BaseTooltip formatter={(p) => formatMs(p.value)} />} />
        <Legend
          wrapperStyle={{ fontSize: 12, color: text }}
          formatter={(value) => <span style={{ color: text }}>{value}</span>}
        />
        <Line type="monotone" dataKey="maxResponseTime" name="Slowest" stroke={CHART_COLORS.degraded} strokeWidth={1.5} dot={false} connectNulls={false} />
        <Line type="monotone" dataKey="avgResponseTime" name="Average" stroke={CHART_COLORS.brand} strokeWidth={2.5} dot={false} connectNulls={false} />
        <Line type="monotone" dataKey="minResponseTime" name="Fastest" stroke={CHART_COLORS.up} strokeWidth={1.5} dot={false} connectNulls={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Uptime percentage over time (0–100). */
export function UptimeChart({ data, height = 260 }) {
  const { grid, text } = useChartTheme();

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
        <defs>
          <linearGradient id="upFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_COLORS.up} stopOpacity={0.3} />
            <stop offset="100%" stopColor={CHART_COLORS.up} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" {...axisProps(grid, text)} vertical={false} />
        <XAxis dataKey="at" {...axisProps(grid, text)} tickFormatter={(v) => formatTime(v)} minTickGap={28} />
        <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} {...axisProps(grid, text)} width={44} />
        <Tooltip
          content={
            <BaseTooltip formatter={(p) => (p.value === null ? 'no data' : `${p.value}%`)} />
          }
        />
        <Area
          type="stepAfter"
          dataKey="uptimePercentage"
          name="Uptime"
          stroke={CHART_COLORS.up}
          strokeWidth={2}
          fill="url(#upFill)"
          connectNulls={false}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Status distribution donut. */
export function StatusDonut({ counts, height = 240 }) {
  const { tooltipBg, border, text } = useChartTheme();

  const data = ['up', 'degraded', 'down', 'paused']
    .map((key) => ({ name: key[0].toUpperCase() + key.slice(1), key, value: counts[key] ?? 0 }))
    .filter((d) => d.value > 0);

  if (data.length === 0) {
    return (
      <div className="center-load" style={{ minHeight: height }}>
        <p>No checks recorded yet</p>
      </div>
    );
  }

  const total = data.reduce((sum, d) => sum + d.value, 0);

  return (
    <div style={{ position: 'relative' }}>
      <ResponsiveContainer width="100%" height={height}>
        <PieChartInner data={data} total={total} tooltipBg={tooltipBg} border={border} text={text} />
      </ResponsiveContainer>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          pointerEvents: 'none',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700 }}>{total}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>checks</div>
        </div>
      </div>
    </div>
  );
}

function PieChartInner({ data, total, tooltipBg, border, text }) {
  return (
    <PieChart>
      <Pie data={data} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="86%" paddingAngle={2}>
        {data.map((entry) => (
          <Cell key={entry.key} fill={CHART_COLORS[entry.key]} />
        ))}
      </Pie>
      <Tooltip
        content={({ active, payload }) =>
          active && payload?.length ? (
            <div
              style={{
                background: tooltipBg,
                border: `1px solid ${border}`,
                borderRadius: 8,
                padding: '6px 10px',
                fontSize: 12,
              }}
            >
              {payload[0].name}: <strong>{payload[0].value}</strong> ({Math.round((payload[0].value / total) * 100)}%)
            </div>
          ) : null
        }
      />
      <text x="50%" y="92%" textAnchor="middle" fill={text} fontSize={11}>
        {data.length} status{data.length === 1 ? '' : 'es'}
      </text>
    </PieChart>
  );
}

/** Daily bar chart used on the monitor detail page. */
export function DailyUptimeChart({ data, height = 220 }) {
  const { grid, text } = useChartTheme();

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" {...axisProps(grid, text)} vertical={false} />
        <XAxis
          dataKey="date"
          {...axisProps(grid, text)}
          tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          minTickGap={20}
        />
        <YAxis domain={[0, 100]} {...axisProps(grid, text)} width={44} />
        <Tooltip
          content={
            <BaseTooltip
              rangeLabel="day"
              formatter={(p) => (p.value === null ? 'no data' : `${p.value}%`)}
            />
          }
        />
        <Area type="monotone" dataKey="uptimePercentage" name="Uptime" stroke={CHART_COLORS.up} strokeWidth={2} fill="url(#upFill)" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}