#!/bin/bash
docker exec smart_assistant_mongo mongosh \
  'mongodb://admin:SmartAssist%402024@localhost:27017/smart_assistant?authSource=admin' \
  --eval "
db.users.updateOne(
  { email: 'citestadmin@example.com' },
  { \$set: {
      serviceId: ObjectId('69a9c576e572d73e78113e84'),
      tenantId: 'coffee-shop-mmdrxx9z',
      storeName: 'Coffee Shop',
      is_verified: true
  }}
);
const u = db.users.findOne({ email: 'citestadmin@example.com' }, { serviceId:1, tenantId:1, is_verified:1, storeName:1 });
print('serviceId: ' + u.serviceId);
print('tenantId: ' + u.tenantId);
print('verified: ' + u.is_verified);
"
