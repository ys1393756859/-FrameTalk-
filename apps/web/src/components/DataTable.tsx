import { useEffect, useState, type ReactNode } from 'react';
import { Table, Empty } from 'antd';
import type { TableProps } from 'antd';
import { useQuery } from '@tanstack/react-query';

export interface FetchParams {
  page: number;
  pageSize: number;
}

export interface FetchResult<T> {
  items: T[];
  total: number;
}

export interface DataTableProps<T> extends Omit<TableProps<T>, 'dataSource' | 'columns' | 'pagination' | 'loading'> {
  columns: TableProps<T>['columns'];
  /** 服务端分页模式：组件管理页码并调用 fetcher */
  fetcher?: (params: FetchParams) => Promise<FetchResult<T>>;
  /** 本地数据模式（与 fetcher 二选一）；数据多时自动前端分页 */
  data?: T[];
  loading?: boolean;
  /** 查询依赖：变化时回到第 1 页重新拉取（服务端模式） */
  queryKey?: unknown[];
  /** 表格上方工具区（筛选器 / 操作按钮），固定高度不随内容变化 */
  toolbar?: ReactNode;
  /** 查询为空时的展示 */
  emptyText?: string;
  pageSizeOptions?: number[];
  /** false 关闭分页（小表）；否则使用组件统一分页 */
  pagination?: false;
}

/**
 * 后台通用表格：**固定尺寸**，不随内容变化产生 UI 波动。
 * - 表体固定高度占满容器剩余空间，行多时表体内滚动（表头/分页器不动）
 * - 所有列强制显式 width（未给的列自动均分剩余宽度），内容超宽 ellipsis 截断
 * - 行高锁定（size=middle），加载/空态不改变容器高度
 * - **操作列规范**：行内操作一律用 components/IconAction（图标+tooltip+可选二次确认），
 *   禁止 <Button>文字</Button>——文字按钮会把操作列撑宽、多操作时横向溢出。详见 IconAction.tsx 注释。
 *
 * 用法约定：外层容器给确定高度（后台页面为 flex 列布局，表格区 flex:1 + minHeight:0）。
 * 以后的后台表格一律用它，不要再裸用 antd Table。
 */
export default function DataTable<T extends object>(props: DataTableProps<T>) {
  const {
    columns, fetcher, data, loading, queryKey, toolbar, emptyText = '暂无数据',
    pageSizeOptions = [20, 50, 100], pagination, ...tableProps
  } = props;

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(pageSizeOptions[0] ?? 20);
  // 筛选条件变化时回到第 1 页
  const queryKeySig = JSON.stringify(queryKey ?? []);
  useEffect(() => { setPage(1); }, [queryKeySig]);

  const remote = useQuery({
    queryKey: ['data-table', ...(queryKey ?? []), page, pageSize],
    queryFn: () => fetcher!({ page, pageSize }),
    enabled: !!fetcher,
    placeholderData: (prev) => prev, // 翻页时保留旧数据避免闪烁
  });

  // 列宽规范：无显式 width 的列均分剩余宽度；全部加 ellipsis 防内容撑开
  const fixedColumns = (columns ?? []).map((col) => {
    const c = { ...col } as any;
    if (c.ellipsis === undefined) c.ellipsis = { showTitle: true };
    return c;
  });

  const dataSource = fetcher ? (remote.data?.items ?? []) : (data ?? []);
  const total = fetcher ? (remote.data?.total ?? 0) : (data?.length ?? 0);
  const busy = fetcher ? remote.isFetching : loading;

  return (
    <div className="ft-data-table" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {toolbar && (
        <div style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
          {toolbar}
        </div>
      )}
      <Table<T>
        {...tableProps}
        columns={fixedColumns}
        dataSource={dataSource}
        loading={busy}
        rowKey={tableProps.rowKey ?? 'id'}
        size={tableProps.size ?? 'middle'}
        scroll={{ x: 'max-content', ...(tableProps.scroll ?? {}) }}
        tableLayout="fixed"
        locale={{ emptyText: <Empty description={emptyText} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={pagination === false ? false : {
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t, range) => `${range[0]}-${range[1]} / 共 ${t} 条`,
          pageSizeOptions,
          onChange: (p, s) => { setPage(p); setPageSize(s); },
        }}
      />
    </div>
  );
}
