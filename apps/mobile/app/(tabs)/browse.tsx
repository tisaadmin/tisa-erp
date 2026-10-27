import { router } from 'expo-router';
import { Card, Row, Screen } from '../../src/components/ui';
import { useAuth } from '../../src/lib/auth';

/** Look anything up: orders, quotations, POs, invoices, receivables, projects. */
export default function Browse() {
  const { can } = useAuth();
  const rows: [string, string, string, string, any][] = [
    ['orders:view', 'Order forms', 'Sales orders, value and progress', '/list/order', 'document-text'],
    ['quotations:view', 'Quotations', 'With costing and margin', '/list/quote', 'pricetags'],
    ['purchase_orders:view', 'Purchase orders', 'Vendors, approval, receipts', '/list/po', 'cart'],
    ['invoices:view', 'Invoices & RA bills', 'Issued bills and payments', '/list/invoice', 'receipt'],
    ['invoices:view', 'Receivables', 'Outstanding by client', '/list/receivables', 'cash'],
    ['grn:view', 'Goods receipts', 'Material received', '/list/grn', 'cube'],
    ['challans:view', 'Delivery challans', 'Material sent to site', '/list/challan', 'car'],
  ];
  return (
    <Screen>
      <Card style={{ padding: 0, gap: 0 }}>
        {rows.filter(([p]) => can(p)).map(([, t, sub, to, icon]) => <Row key={to} icon={icon} title={t} sub={sub} onPress={() => router.push(to as never)} />)}
        <Row icon="business" title="Projects" sub="Material to site, team, installation" onPress={() => router.push('/projects')} />
      </Card>
    </Screen>
  );
}
