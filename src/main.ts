import Table from 'cli-table';
import firebase from 'firebase-admin';
import prompts from 'prompts';
import UUID from 'uuid';

async function main() {
    firebase.initializeApp({
        credential: firebase.credential.cert(require('../credentials.json')),
        databaseURL: 'https://kicker-table-70dcf.firebaseio.com'
    });

    const database = firebase.database();

    while(true) {
        const task = await taskInput();
        if(!task) {
            return taskExit();
        }
        await tasks.get(task)!(database);
    }
}

const tasks = new Map<string, (db : firebase.database.Database) => Promise<void>|void>([
    [ 'add user', taskAddUser ],
    [ 'list user', taskListUser ],
    [ 'add match', taskAddMatch ],
    [ 'list matches', taskListMatches ],
    [ 'exit', taskExit ]
]);

function read(ref : firebase.database.Reference) {
    return new Promise<firebase.database.DataSnapshot>(resolve => {
        ref.once('value', resolve)
    });
}

function set(ref : firebase.database.Reference, value : any) {
    return new Promise<void>((resolve, reject) => {
        ref.set(value, error => {
            error ? reject(error) : resolve();
        });
    })
}


async function taskAddUser(db : firebase.database.Database) {
    const ref = db.ref('users');
    const users = Object.values<IUser>((await read(ref)).val() || {});
    const { name, elo } = await prompts([
        { 
            type: 'text',
            name: 'name',
            message: 'Name',
            validate: name => {
                if(users.some(u => u.name === name)) {
                    return `User '${name}' already exists.`;
                }
                return true;
            }
        },
        {
            type: 'number',
            name: 'elo',
            message: 'Initial ELO',
            initial: 1000,
            validate: elo => {
                if(0 > elo) {
                    return `ELO must be positive`;
                }
                return true;
            }
        }
    ]);

    const id = UUID.v4();

    await set(ref.child(id), { id, name, elo });
}

async function taskListUser(db : firebase.database.Database) {
    const ref = db.ref('users');
    const users = Object.values<IUser>((await read(ref)).val() || {});
    users.sort((a, b) => b.elo - a.elo);

    const table = new Table({
        head: [ '#', 'ELO', 'Name' ],
        colWidths: [ 4, 6, 24 ],
        colAligns: [ 'right', 'right', 'left' ]
    })

    table.push(...users.map((user, index) => [ index + 1, user.elo, user.name ]));

    console.log(table.toString());
}

async function taskAddMatch(db : firebase.database.Database) {
    const ref = db.ref('matches');
    const usersRef = db.ref('users');
    const users = Object.values<IUser>((await read(db.ref('users'))).val());
    function userChoices(...not : string[]) {
        return users.filter(user => {
            return !not.includes(user.id);
        }).map(user => ({
            title: user.name,
            value: user.id
        }));
    }

    const { a0Id } = await prompts({
        type: 'autocomplete',
        name: 'a0Id',
        message: 'Team A Player 1',
        choices: userChoices(),
        limit: 5
    });
    if(!a0Id) return;

    const { a1Id } = await prompts({
        type: 'autocomplete',
        name: 'a1Id',
        message: 'Team A Player 2',
        choices: userChoices(a0Id),
        limit: 5
    });
    if(!a1Id) return;

    const { b0Id } = await prompts({
        type: 'autocomplete',
        name: 'b0Id',
        message: 'Team B Player 1',
        choices: userChoices(a0Id, a1Id),
        limit: 5
    });
    if(!b0Id) return;

    const { b1Id } = await prompts({
        type: 'autocomplete',
        name: 'b1Id',
        message: 'Team B Player 2',
        choices: userChoices(a0Id, a1Id, b0Id),
        limit: 5
    });
    if(!b1Id) return;

    const { rA, rB } = await prompts([
        {
            type: "number",
            name: 'rA',
            message: 'Result Team A',
            initial: 0
        },
        {
            type: "number",
            name: 'rB',
            message: 'Result Team B',
            initial: 0
        }
    ]);

    const a0 = users.find(u => u.id === a0Id)!;
    const a1 = users.find(u => u.id === a1Id)!;
    const b0 = users.find(u => u.id === b0Id)!;
    const b1 = users.find(u => u.id === b1Id)!;

    const pA0 = await findLatestMatchByUser(db, a0.name);
    const pA1 = await findLatestMatchByUser(db, a1.name);
    const pB0 = await findLatestMatchByUser(db, b0.name);
    const pB1 = await findLatestMatchByUser(db, b1.name);

    const match : IMatch = {
        id: UUID.v4(),
        date: new Date().toISOString(),
        teams: JSON.parse(JSON.stringify([ [ a0, a1 ], [ b0, b1 ]])),
        parent: [ [ pA0 ? pA0.id : null, pA1 ? pA1.id : null], [ pB0 ? pB0.id : null, pB1 ? pB1.id : null] ],
        result: [ rA, rB ]
    }

    const aELO = (a0.elo + a1.elo) / 2;
    const bELO = (b0.elo + b1.elo) / 2;

    const [ eA, eB ] = expectation(aELO, bELO);

    a0.elo = eloChange(a0.elo, rA > rB ? 1 : rA === rB ? 0.5 : 0, eA);
    a1.elo = eloChange(a1.elo, rA > rB ? 1 : rA === rB ? 0.5 : 0, eA);

    b0.elo = eloChange(b0.elo, rA > rB ? 0 : rA === rB ? 0.5 : 1, eB);
    b1.elo = eloChange(b1.elo, rA > rB ? 0 : rA === rB ? 0.5 : 1, eB);

    await set(usersRef.child(a0.id), a0);
    await set(usersRef.child(a1.id), a1);
    await set(usersRef.child(b0.id), b0);
    await set(usersRef.child(b1.id), b1);

    await set(ref.child(match.id), match);
}

async function taskListMatches(db : firebase.database.Database) {
    const matches = Object.values<IMatch>((await read(db.ref('matches'))).val() || {});
    matches.sort((a, b) => a.date.localeCompare(b.date));

    const table = new Table({
        head: [ 'Date', 'Team A', '', 'Result', '', 'Team B' ],
        colAligns: [ 'left', 'right', 'right', 'middle', 'left', 'left' ],
        colWidths: [ 26, 30, 6, 9, 6, 30 ]
    });

    table.push(...matches.map(match => {
        const aELO = (match.teams[0][0].elo + match.teams[0][1].elo) / 2;
        const bELO = (match.teams[1][0].elo + match.teams[1][1].elo) / 2;
        const [eA, eB] = expectation(aELO, bELO);
        return [
            match.date,
            `${match.teams[0].map(user => `${user.name}(${user.elo})`).join(', ')}`,
            eA.toFixed(2),
            `${match.result[0]}:${match.result[1]}`,
            eB.toFixed(2),
            `${match.teams[1].map(user => `${user.name}(${user.elo})`).join(', ')}` 
        ];
    }))

    console.log(table.toString());
}

function taskExit() {
    console.log('Bye');
    process.exit();
}

function taskInput() {
    return prompts({
        type: 'autocomplete',
        name: 'task',
        message: 'Do',
        choices: [ ...tasks.keys() ].map(name => ({ title: name, value: name })),
        limit: 5
    }).then(({ task }) => task);
}

function expectation(a: number, b: number) : [ number, number ] {
    const eA = 1/(1+10**(diff(a, b)/400));

    return [ eA, 1 - eA ];
}

function eloChange(r : number, s : number, e : number, k = 30) {
    return Math.round(r + k * (s - e));
}

function diff(a : number, b : number) {
    return Math.max(-400, Math.min(400, b - a));
}

async function findLatestMatchByUser(db : firebase.database.Database, name: string) {
    const matches = Object.values<IMatch>((await read(db.ref('matches'))).val() || {});
    matches.sort((a, b) => b.date.localeCompare(a.date));

    return matches.filter(match => {
        return match.teams.some(team => team.some(user => user.name === name));
    })[0];
}

main().catch(err => {
    console.error(err);
    process.exit(1);
})

interface IUser {
    id: string;
    name: string;
    elo: number;
}

type Teams = [ IUser[], IUser[] ];
type Result = [ number, number ];

interface IMatch {
    id: string;
    date: string;
    teams: Teams;
    parent: [ (string|null)[], (string|null)[] ],
    result: Result;
}