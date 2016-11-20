import reject from 'lodash/reject';
import filter from 'lodash/filter';
import orderBy from 'lodash/orderBy';
import ops from 'immutable-ops';

import { FILTER, EXCLUDE, ORDER_BY } from '../constants';
import { includes } from '../utils';


function isNumber(value) {
    return !isNaN(parseFloat(value)) && isFinite(value);
}


const DEFAULT_OPTS = {
    idAttribute: 'id',
    arrName: 'items',
    mapName: 'itemsById',
};

/**
 * Handles the underlying data structure for a {@link Model} class.
 */
const Table = class Table {
    /**
     * Creates a new {@link Table} instance.
     * @param  {Object} userOpts - options to use.
     * @param  {string} [userOpts.idAttribute=id] - the id attribute of the entity.
     * @param  {string} [userOpts.arrName=items] - the state attribute where an array of
     *                                             entity id's are stored
     * @param  {string} [userOpts.mapName=itemsById] - the state attribute where the entity objects
     *                                                 are stored in a id to entity object
     *                                                 map.
     */
    constructor(userOpts) {
        Object.assign(this, DEFAULT_OPTS, userOpts);
    }

    /**
     * Returns a reference to the object at index `id`
     * in state `branch`.
     *
     * @param  {Object} branch - the state
     * @param  {Number} id - the id of the object to get
     * @return {Object|undefined} A reference to the raw object in the state or
     *                            `undefined` if not found.
     */
    accessId(branch, id) {
        return branch[this.mapName][id];
    }

    idExists(branch, id) {
        return branch[this.mapName].hasOwnProperty(id);
    }

    accessIdList(branch) {
        return branch[this.arrName];
    }

    accessList(branch) {
        return branch[this.arrName].map(id => this.accessId(branch, id));
    }

    getMaxId(branch) {
        return this.getMeta(branch, 'maxId');
    }

    setMaxId(tx, branch, newMaxId) {
        return this.setMeta(tx, branch, 'maxId', newMaxId);
    }

    nextId(id) {
        return id + 1;
    }

    query(branch, clauses) {
        return clauses.reduce((rows, { type, payload }) => {
            switch (type) {
            case FILTER: {
                if (payload.hasOwnProperty(this.idAttribute) && payload[this.idAttribute]) {
                    // Payload specified a primary key; Since that is unique, we can directly
                    // return that.
                    const id = payload[this.idAttribute];
                    return this.idExists(branch, id)
                        ? [this.accessId(branch, payload[this.idAttribute])]
                        : [];
                }
                return filter(rows, payload);
            }
            case EXCLUDE: {
                return reject(rows, payload);
            }
            case ORDER_BY: {
                const [iteratees, orders] = payload;
                return orderBy(rows, iteratees, orders);
            }
            default:
                return rows;
            }
        }, this.accessList(branch));
    }

    /**
     * Returns the default state for the data structure.
     * @return {Object} The default state for this {@link Backend} instance's data structure
     */
    getEmptyState() {
        return {
            [this.arrName]: [],
            [this.mapName]: {},
            meta: {},
        };
    }

    setMeta(tx, branch, key, value) {
        const { batchToken, withMutations } = tx;
        if (withMutations) {
            const res = ops.mutable.setIn(['meta', key], value, branch);
            return res;
        }

        return ops.batch.setIn(batchToken, ['meta', key], value, branch);
    }

    getMeta(branch, key) {
        return branch.meta[key];
    }

    /**
     * Returns the data structure including a new object `entry`
     * @param  {Object} tx - transaction info
     * @param  {Object} branch - the data structure state
     * @param  {Object} entry - the object to insert
     * @return {Object} the data structure including `entry`.
     */
    insert(tx, branch, entry) {
        const { batchToken, withMutations } = tx;

        const hasId = entry.hasOwnProperty(this.idAttribute);

        let workingState = branch;

        let id;
        if (!hasId) {
            const maxId = this.getMaxId(branch);
            if (maxId === undefined) {
                id = 0;
            } else {
                id = maxId + 1;
            }
            workingState = this.setMaxId(tx, branch, id);
        } else {
            id = entry[this.idAttribute];
        }

        const finalEntry = hasId
            ? entry
            : ops.batch.set(batchToken, this.idAttribute, id, entry);

        if (withMutations) {
            ops.mutable.push(id, workingState[this.arrName]);
            ops.mutable.set(id, finalEntry, workingState[this.mapName]);
            return {
                state: workingState,
                created: finalEntry,
            };
        }

        const nextState = ops.batch.merge(batchToken, {
            [this.arrName]: ops.batch.push(batchToken, id, workingState[this.arrName]),
            [this.mapName]: ops.batch.merge(batchToken, { [id]: finalEntry }, workingState[this.mapName]),
        }, workingState);

        return {
            state: nextState,
            created: finalEntry,
        };
    }

    /**
     * Returns the data structure with objects where id in `idArr`
     * are merged with `mergeObj`.
     *
     * @param  {Object} tx - transaction info
     * @param  {Object} branch - the data structure state
     * @param  {Array} idArr - the id's of the objects to update
     * @param  {Object} mergeObj - The object to merge with objects
     *                             where their id is in `idArr`.
     * @return {Object} the data structure with objects with their id in `idArr` updated with `mergeObj`.
     */
    update(tx, branch, rows, mergeObj) {
        const { batchToken, withMutations } = tx;

        const {
            mapName,
        } = this;

        const mapFunction = row => {
            const merge = withMutations ? ops.mutable.merge : ops.batch.merge(batchToken);
            return merge(mergeObj, row);
        };

        const set = withMutations ? ops.mutable.set : ops.batch.set(batchToken);

        const newMap = rows.reduce((map, row) => {
            const result = mapFunction(row);
            return set(result[this.idAttribute], result, map);
        }, branch[mapName]);
        return ops.batch.set(batchToken, mapName, newMap, branch);
    }

    /**
     * Returns the data structure without objects with their id included in `idsToDelete`.
     * @param  {Object} tx - transaction info
     * @param  {Object} branch - the data structure state
     * @param  {Array} idsToDelete - the ids to delete from the data structure
     * @return {Object} the data structure without ids in `idsToDelete`.
     */
    delete(tx, branch, rows) {
        const { batchToken, withMutations } = tx;

        const { arrName, mapName } = this;
        const arr = branch[arrName];

        const idsToDelete = rows.map(row => row[this.idAttribute]);
        if (withMutations) {
            idsToDelete.forEach(id => {
                const idx = arr.indexOf(id);
                if (idx !== -1) {
                    ops.mutable.splice(idx, 1, [], arr);
                }

                ops.mutable.omit(id, branch[mapName]);
            });
            return branch;
        }

        return ops.batch.merge(batchToken, {
            [arrName]: ops.batch.filter(
                batchToken,
                id => !includes(idsToDelete, id),
                branch[arrName]
            ),
            [mapName]: ops.batch.omit(
                batchToken,
                idsToDelete,
                branch[mapName]
            ),
        }, branch);
    }
};

export default Table;