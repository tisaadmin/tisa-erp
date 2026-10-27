import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { ApprovalCard } from '../../../src/components/Approve';
import { Badge, C, Card, Empty, Screen, s, useFetch } from '../../../src/components/ui';
import { fmtDate, inr, label } from '../../../src/lib/format';
import type { Inbox } from '../../../src/lib/manage';

const PATH: Record<string, string> = { order: '/orders', quote: '/quotations', po: '/purchase-orders', invoice: '/invoices', grn: '/grns', challan: '/challans' };
const NAME: Record<string, string> = { order: 'Order', quote: 'Quotation', po: 'Purchase order', invoice: 'Invoice', grn: 'Goods receipt', challan: 'Challan' };

function KV({ rows }: { rows: [string, string | number | null | undefined][] }) {
  return (
    <View style={{ gap: 6 }}>
      {rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
        <View key={k} style={{ flexDirection: 'row', gap: 10 }}><Text style={[s.muted, { width: 110 }]}>{k}</Text><Text style={{ flex: 1, color: C.text, fontSize: 14 }}>{String(v)}</Text></View>
      ))}
    </View>
  );
}

/** Any document on the phone: header, lines, totals — and approve / send back when it is waiting for you. */
export default function Doc() {
  const { kind, id } = useLocalSearchParams<{ kind: string; id: string }>();
  const d = useFetch<any>(PATH[kind] ? `${PATH[kind]}/${id}` : null);
  const inbox = useFetch<Inbox>('/approvals/inbox');
  const billing = useFetch<{ summary: { orderTaxable: number; billedTaxable: number; balanceTaxable: number; billedPct: number } }>(kind === 'order' ? `/orders/${id}/billing` : null);
  const x = d.data;
  const waiting = inbox.data?.items.find((i) => i.id === id);
  const reload = () => { d.reload(); inbox.reload(); billing.reload(); };
  if (!PATH[kind]) return <Empty text="Unknown document" />;
  const party = x?.client?.name ?? x?.vendor?.name ?? x?.lead?.name;
  const head: [string, any][] = !x ? [] : [
    ['Date', fmtDate(x.date)],
    [kind === 'po' || kind === 'grn' ? 'Vendor' : 'Client', party],
    ['Site', x.site?.name ?? x.deliverToSite?.name],
    ['Subject', x.subject],
    ['Order', x.salesOrder?.number ?? x.order?.number],
    ['PO', x.po?.number],
    ['Client PO', x.clientPoNo],
    ['Type', x.type ? label(x.type) : null],
    ['Due', x.dueDate ? fmtDate(x.dueDate) : null],
    ['Vehicle', x.vehicleNo],
    ['Remarks', x.notes],
  ];
  const lines: any[] = x?.items ?? [];
  return (
    <Screen onRefresh={reload} refreshing={d.loading}>
      <Stack.Screen options={{ title: x?.number ?? NAME[kind] }} />
      {!!d.error && <Empty text={d.error} />}
      {waiting && <ApprovalCard item={waiting} noLink onDone={() => { reload(); router.back(); }} />}
      {x && (
        <>
          <Card title={`${NAME[kind]} ${x.number ?? ''}`} right={<Badge text={x.status} />}>
            <KV rows={head} />
          </Card>
          {kind === 'order' && billing.data && (
            <Card title="Billing">
              <View style={{ height: 8, backgroundColor: '#f1f5f9', borderRadius: 4 }}><View style={{ width: `${Math.min(100, billing.data.summary.billedPct)}%`, height: 8, backgroundColor: C.brand, borderRadius: 4 }} /></View>
              <KV rows={[['Billed', `${inr(billing.data.summary.billedTaxable)} (${billing.data.summary.billedPct}%)`], ['Balance', inr(billing.data.summary.balanceTaxable)]]} />
            </Card>
          )}
          {kind === 'quote' && x.costingSummary && (
            <Card title="Costing (internal)">
              <KV rows={[['Material cost', inr(x.costingSummary.material)], ['Total cost', inr(x.costingSummary.totalCost)], ['Gross profit', `${inr(x.costingSummary.grossProfit)} · ${x.costingSummary.gpPct}%`], ['Target', `${x.costingSummary.minGpPct}%`]]} />
            </Card>
          )}
          {lines.length > 0 && (
            <Card title={`Items (${lines.length})`}>
              {lines.map((l, i) => (
                <View key={l.id ?? i} style={{ gap: 2, paddingBottom: 8, borderBottomWidth: i < lines.length - 1 ? 1 : 0, borderBottomColor: '#eef2f7' }}>
                  <Text style={{ fontSize: 14, color: C.text }}>{l.useAltDescription && l.altDescription ? l.altDescription : l.description}</Text>
                  <Text style={s.muted}>
                    {l.qty != null ? `${Number(l.qty)} ${l.unit ?? ''}` : l.acceptedQty != null ? `accepted ${Number(l.acceptedQty)}` : ''}
                    {l.rate != null ? ` × ${inr(l.rate)}` : ''}{l.taxable != null ? ` = ${inr(l.taxable)}` : ''}
                    {l.deliveredQty != null && kind === 'order' ? ` · delivered ${Number(l.deliveredQty)}` : ''}
                    {l.receivedQty != null && kind === 'po' ? ` · received ${Number(l.receivedQty)}` : ''}
                    {l.costRate != null ? ` · cost ${inr(l.costRate)}` : ''}
                    {Number(l.excessQty) > 0 ? ` · +${Number(l.excessQty)} over the order` : ''}
                  </Text>
                </View>
              ))}
            </Card>
          )}
          {x.total != null && (
            <Card title="Totals">
              <KV rows={[['Taxable', inr(x.taxable)], ['CGST', x.cgst ? inr(x.cgst) : null], ['SGST', x.sgst ? inr(x.sgst) : null], ['IGST', x.igst ? inr(x.igst) : null], ['Total', inr(x.total)],
                ['Received', kind === 'invoice' ? inr(x.amountPaid) : null], ['Balance', kind === 'invoice' ? inr(Number(x.total) - Number(x.amountPaid ?? 0)) : null]]} />
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}
