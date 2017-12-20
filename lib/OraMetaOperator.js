/* sqb-connect-oracle
 ------------------------
 (c) 2017-present Panates
 SQB may be freely distributed under the MIT license.
 For details and documentation:
 https://panates.github.io/sqb-connect-oracle/
 */

const Promise = global.Promise;

/**
 * Expose `OraMetaOperator`.
 */
module.exports = OraMetaOperator;

/**
 * @param {Object} sqbObj
 * @constructor
 */
function OraMetaOperator(sqbObj) {
}

const proto = OraMetaOperator.prototype;

proto.querySchemas = function(db) {
  return db
      .select('username schema_name')
      .from('dba_users u');
};

proto.queryTables = function(db) {
  const query = db
      .select('t.owner schema_name', 'table_name', 'num_rows', 'temporary',
          db.select('comments').from('all_tab_comments atc')
              .where(['atc.owner', db.raw('t.owner')],
                  ['atc.table_name', db.raw('t.table_name')])
              .as('table_comments')
      )
      .from('all_tables t')
      .orderBy('t.owner', 't.table_name');
  query.on('fetch', function(row) {
    row.set('temporary', row.get('temporary') === 'Y');
  });
  return query;
};

proto.queryColumns = function(db) {
  const query = db
      .select('t.owner schema_name', 't.table_name', 'c.column_name',
          'c.data_type', 'c.data_type data_type_mean',
          'c.data_length', 'c.data_precision', 'c.data_scale',
          'c.char_length', 'c.data_default default_value',
          db.case().when('c.nullable', 'Y').then(0).else(1).as('is_notnull'),
          db.select('comments').from('all_col_comments acc')
              .where(['acc.owner', db.raw('t.owner')],
                  ['acc.table_name', db.raw('t.table_name')],
                  ['acc.column_name', db.raw('c.column_name')]
              )
              .as('column_comments')
      )
      .from('all_tables t')
      .join(db.join('all_tab_columns c')
          .on(['c.owner', db.raw('t.OWNER')],
              ['c.table_name', db.raw('t.table_name')]))
      .orderBy('t.owner', 't.table_name', 'c.column_id');
  query.on('fetch', function(row) {
    switch (row.get('data_type')) {
      case 'NCHAR':
        row.set('data_type_mean', 'CHAR');
        break;
      case 'NCLOB':
        row.set('data_type_mean', 'CLOB');
        break;
      case 'VARCHAR2':
      case 'NVARCHAR2':
      case 'LONG':
      case 'ROWID':
      case 'UROWID':
        row.set('data_type_mean', 'VARCHAR');
        break;
      case 'LONG RAW':
      case 'BINARY_FLOAT':
      case 'BINARY_DOUBLE':
      case 'data_type':
        row.set('data_type_mean', 'BUFFER');
        break;
    }
    if (row.get('data_type').substring(0, 9) === 'TIMESTAMP')
      row.set('data_type_mean', 'TIMESTAMP');
  });
  return query;
};

proto.queryPrimaryKeys = function(db) {
  const query = db
      .select('t.owner schema_name', 't.table_name', 't.constraint_name', 't.status enabled',
          db.raw('to_char(listagg(acc.column_name, \',\') within group (order by null)) columns')
      )
      .from('all_constraints t')
      .join(
          db.join('all_cons_columns acc')
              .on(['acc.owner', db.raw('t.owner')],
                  ['acc.constraint_name', db.raw('t.constraint_name')]
              )
      ).where(['t.constraint_type', 'P'])
      .groupBy('t.owner', 't.table_name', 't.constraint_name', 't.status');
  query.on('fetch', function(row) {
    row.enabled = row.enabled === 'ENABLED';
  });
  return query;
};

proto.queryForeignKeys = function(db) {
  const query = db
      .select('t.owner schema_name', 't.table_name', 't.constraint_name', 'acc.column_name',
          't.r_owner foreign_schema', 'acr.table_name foreign_table_name',
          db.raw('to_char(listagg(acr.column_name, \',\') within group (order by null)) foreign_columns'),
          't.status enabled'
      )
      .from('all_constraints t')
      .join(
          db.join('all_cons_columns acc')
              .on(['acc.owner', db.raw('t.owner')],
                  ['acc.constraint_name', db.raw('t.constraint_name')]
              ),
          db.join('all_cons_columns acr')
              .on(['acr.owner', db.raw('t.r_owner')],
                  ['acr.constraint_name', db.raw('t.r_constraint_name')]
              )
      ).where(['t.constraint_type', 'R'])
      .groupBy('t.owner', 't.table_name', 't.constraint_name', 'acc.column_name',
          't.r_owner', 'acr.table_name', 't.status');
  query.on('fetch', function(row) {
    row.enabled = row.enabled === 'ENABLED';
  });
  return query;
};

proto.getTableInfo = function(db, schema, tableName, callback) {
  const self = this;
  const result = {};
  Promise.all([
    /* Columns resolver */
    new Promise(function(resolve, reject) {
      const query = self.queryColumns(db)
          .where(['t.owner', schema], ['t.table_name', tableName]);
      query.execute({
        fetchRows: 100000,
        objectRows: true,
        naming: 'lowercase'
      }, function(err, resp) {
        if (err)
          return reject(err);
        result.columns = {};
        resp.rows.forEach(function(row, i) {
          row = result.columns[row.column_name] =
              Object.assign({column_index: i}, row);
          delete row.schema_name;
          delete row.table_name;
          delete row.column_name;
        });
        resolve();
      });
    }),
    /* Primary key resolver */
    new Promise(function(resolve, reject) {
      const query = self.queryPrimaryKeys(db)
          .where(['t.owner', schema], ['t.table_name', tableName]);
      query.execute({
        fetchRows: 100000,
        objectRows: true,
        naming: 'lowercase'
      }, function(err, resp) {
        if (err)
          return reject(err);
        if (resp.rows.length) {
          const row = result.primaryKey = resp.rows[0];
          delete row.schema_name;
          delete row.table_name;
        }
        resolve();
      });
    }),
    /* Foreign keys resolver */
    new Promise(function(resolve, reject) {
      const query = self.queryForeignKeys(db)
          .where(['t.owner', schema], ['t.table_name', tableName]);
      query.execute({
        fetchRows: 100000,
        objectRows: true,
        naming: 'lowercase'
      }, function(err, resp) {
        if (err)
          return reject(err);
        if (resp.rows.length) {
          result.foreignKeys = [];
          resp.rows.forEach(function(row) {
            delete row.schema_name;
            delete row.table_name;
            result.foreignKeys.push(row);
          });
        }
        resolve();
      });
    })
  ]).then(function() {
    callback(null, result);
  }).catch(callback);
};