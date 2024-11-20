const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { Web3 } = require('web3');
require('dotenv').config();

const RPC = process.env.RPC || 'https://rpc.mevblocker.io';
const ADDRESS_COL = Number(process.env.ADDRESS_COL || '0');
const VALUE_COL = Number(process.env.VALUE_COL || '3');
const IN_FILE = process.env.IN_FILE || 'in_file.csv';
const OUT_FILE = process.env.OUT_FILE || 'out_file.csv';
const THRESHOLD = Number(process.env.THRESHOLD || '0'); // skip too small payouts
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const BATCH_SIZE = Number(process.env.BATCH_SIZE || '100'); //
const START_LINE = Number(process.env.START_LINE || '0'); //
const TOKEN_CONTRACT = process.env.TOKEN_CONTRACT || ''; // d223:  0x0908078Da2935A14BC7a17770292818C85b580dd
const GAS = BigInt(process.env.GAS || '21000'); // 21000 - default for Coin, set 60000 and more - for tokens

const ERC20 = [{"constant":true,"inputs":[],"name":"ticker","outputs":[{"name":"","type":"string"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[],"name":"name","outputs":[{"name":"","type":"string"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_spender","type":"address"},{"name":"_value","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[],"name":"totalSupply","outputs":[{"name":"","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_from","type":"address"},{"name":"_to","type":"address"},{"name":"_value","type":"uint256"}],"name":"transferFrom","outputs":[{"name":"","type":"bool"}],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[{"name":"_owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"balance","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"","type":"string"}],"payable":false,"stateMutability":"view","type":"function"},{"constant":false,"inputs":[{"name":"_to","type":"address"},{"name":"_value","type":"uint256"}],"name":"transfer","outputs":[{"name":"","type":"bool"}],"payable":false,"stateMutability":"nonpayable","type":"function"},{"constant":true,"inputs":[{"name":"_owner","type":"address"},{"name":"_spender","type":"address"}],"name":"allowance","outputs":[{"name":"","type":"uint256"}],"payable":false,"stateMutability":"view","type":"function"},{"payable":true,"stateMutability":"payable","type":"fallback"},{"anonymous":false,"inputs":[{"indexed":true,"name":"owner","type":"address"},{"indexed":true,"name":"spender","type":"address"},{"indexed":false,"name":"value","type":"uint256"}],"name":"Approval","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"name":"from","type":"address"},{"indexed":true,"name":"to","type":"address"},{"indexed":false,"name":"value","type":"uint256"}],"name":"Transfer","type":"event"}];

// Using globals to minimize functions call params
let gasPrice;
let decimals = 18;
let contract;
let web3;
let sourceAddress;

async function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(() => resolve(-1), ms);
    });
}

async function getGasPrice() {
    const block = await (web3.eth.getBlock('pending'));

    let gasPriority = {};

    let gasPrice = await web3.eth.getGasPrice(); // 30 gwei min
    console.log(`GasPrice: ${web3.utils['fromWei'](gasPrice, 'gwei')}`);
    // if (nodeName === 'clo') gasPrice = 1002000000000n;
    // const priorityMult = (nodeName === 'polygon') ? 4n : 1n;
    const priorityMult = 1n;

    if (block.baseFeePerGas) { //} && nodeName !== 'polygon') {
        const baseFee = block.baseFeePerGas;
        console.log(`base fee: ${web3.utils['fromWei'](baseFee, 'gwei')}`);
        let priorityFee = BigInt(Math.abs(Number(gasPrice - baseFee)));
        console.log(`priorityFee base: ${web3.utils['fromWei'](priorityFee, 'gwei')}`);
        priorityFee = priorityFee > 0n ? priorityFee * priorityMult : 10000000n;
        console.log(`priorityFee: ${web3.utils['fromWei'](priorityFee, 'gwei')}`);
        const maxFeePerGas = block.baseFeePerGas * 11n / 10n + priorityFee;
        console.log(`maxFeePerGas: ${web3.utils['fromWei'](maxFeePerGas, 'gwei')}`);

        gasPriority.maxPriorityFeePerGas = priorityFee;
        gasPriority.maxFeePerGas = maxFeePerGas; // take 1%s
    } else {
        gasPriority.gasPrice = gasPrice;
    }

    return gasPriority;
}

function tokenToWei(value) {
    let locDecimals = Number(decimals);
    let dec = 3;
    if (dec > decimals) dec = 0;
    locDecimals -= dec;
    locDecimals = BigInt(locDecimals);
    const resValue = Math.round(value * Math.pow(10, dec));
    const tokenAmount = BigInt(resValue);
    const poww = BigInt(10) ** locDecimals;
    return tokenAmount * poww;
}

async function sendTx(key, address, value, nonce) {
    let txConfig;
    
    try {
        if (TOKEN_CONTRACT) {
            const weiValue = tokenToWei(value);
            const encodedABI = contract.methods.transfer(address, weiValue).encodeABI();
            txConfig = {
                from: sourceAddress,
                to: TOKEN_CONTRACT,
                gas: GAS,
                nonce,
                data: encodedABI,
                ...gasPrice
            };
        } else {
            txConfig = {
                to: address,
                value: web3.utils['toWei'](value, 'ether'),
                gas: GAS,
                nonce,
                ...gasPrice
            };
        }
    } catch (e) {
        console.error(e);
        process.exit(1);
    }

    // console.dir(txConfig);

    try {
        const signed = await web3.eth.accounts.signTransaction(txConfig, key);
        await web3.eth.sendSignedTransaction(signed.rawTransaction);
        return signed.transactionHash;
    } catch (e) {
        console.error(e);
        throw e;
    }
}

function getAddressFromKey(key) {
    let keyStr = key;
    if (key.indexOf('0x') !== 0) {
        keyStr = `0x${key}`;
    }
    const account = web3.eth.accounts.privateKeyToAccount(keyStr);
    return account.address;
}

async function getTokenSymbol(token) {
    try {
        const symbol = await token.methods.symbol().call({data: '0x1'}); // symbol
        console.log(`Token symbol: ${symbol}`);
        return decimals;
    } catch (e) {
        console.error(`Failed to get Token symbol...`);
    }
    
}

async function getTokenDecimals(token) {
    let decimals;
    try {
        decimals = await token.methods.decimals().call({data: '0x1'}); // decimals
    } catch (e) {
        decimals = 18;
    }
    console.log(`Token decimals: ${decimals}`);
    return decimals;
}

function parseCSV(filePath) {
    const results = [];
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });

    let counter = 0;

    return new Promise((resolve, reject) => {
        // Event listener for each line in the CSV file
        rl.on('line', (line) => {
            counter++;
            if (counter > START_LINE) {
                const values = line.split(';');

                // Process each value as needed
                const val = parseFloat(values[VALUE_COL]);
                if (!isNaN(val)) {
                    if (val >= THRESHOLD) {
                        results.push([values[ADDRESS_COL], val]);
                    }
                } else {
                    console.error(`NaN: ${values[VALUE_COL]}`);
                }
            }
        });

        // Event listener when the file reading is complete
        rl.on('close', () => {
            // The CSV parsing is complete
            resolve(results);
        });

        // Event listener for errors during file reading
        fileStream.on('error', (error) => {
            // Handle errors during file reading
            reject(error);
        });
    });
}

// main ()
(async () => {
     // init Web3 provider
    web3 = new Web3(RPC);
    const netId = await web3.eth.net.getId();
    console.log(`Connected to Web3`);
    
    if (TOKEN_CONTRACT) {
        console.log(`Working with Token: ${TOKEN_CONTRACT}`);
        try {
            contract = new web3.eth.Contract(ERC20, TOKEN_CONTRACT);
            decimals = await getTokenDecimals(contract);
            await getTokenSymbol(contract);
        } catch (error) {
            console.error('Error reading Token contract');
            console.error(error);
            return;   
        }
    }

    let workArray = [];
    try {
        workArray = await parseCSV(path.resolve(__dirname + `/${IN_FILE}`));
    } catch (e) {
        console.error('Error reading file');
        console.error(e);
        return;
    }
    
    console.log(`Got ${workArray.length} addresses to send`);

    let sum = 0;
    for (let line of workArray) {
        sum += line[1];
    }

    if (!PRIVATE_KEY) {
        console.log('Please provide PRIVATE KEY of your wallet in PRIVATE_KEY env variable.');
        return;
    }

    const outFile = path.resolve(__dirname + `/${OUT_FILE}`);
    if (fs.existsSync(outFile)) {
        //
    } else {
        try {
            fs.mkdirSync(path.dirname(outFile));
        } catch (e) {
            console.log(`Error creating dir ${e.toString()}`);
        }
        fs.writeFileSync(outFile, '', 'utf8');
        fs.appendFileSync(outFile,`address;value;tx_hash`);
    }


    sourceAddress = getAddressFromKey(PRIVATE_KEY);
    console.log(`Source wallet address; ${sourceAddress}`);

    // check wallet Fee balance
    const feeRequired = workArray.length * 0.0004; // 0.022 - for clo
    const weiBalance = await web3.eth.getBalance(sourceAddress);
    const walletBalance = Number(web3.utils['fromWei'](weiBalance, 'ether'));

    console.log(`Source balance: ${walletBalance}`);
    
    if (TOKEN_CONTRACT) {
        if ((feeRequired) > walletBalance) {
            console.log(`Not enough Fee Coin on your Wallet.\nRequired for Fee: ${feeRequired}`);
            return;
        }
    }  else {
        if ((sum + feeRequired) > walletBalance) {
            console.log(`Not enough Coin on your Wallet.\nRequired for Fee & Transfer: ${sum + feeRequired}`);
            return;
        }
    }

    gasPrice = process.env.GAS_PRICE ? BigInt(process.env.GAS_PRICE + '000000000') : await getGasPrice();
    const batchDelay = Number(process.env.BATCH_DELAY || '7');

    let finished = false;
    while (!finished) {
        let toRepeat = [];

        let promises = [];
        let processing = [];
        let count = 0;
        let nonce = await web3.eth.getTransactionCount(sourceAddress);
        for (let j = 0; j < workArray.length; j++) {
            count++;
            const line = workArray[j];
            processing.push(line);
            promises.push(sendTx(PRIVATE_KEY, line[0], line[1], nonce));
            nonce++;

            if (count === BATCH_SIZE || j === workArray.length-1) {
                const results = await Promise.allSettled(promises);

                // parse results
                for (let i = 0; i < promises.length; i++) {
                    const res = results[i];
                    if (res.status === 'fulfilled') {
                        const procLine = processing[i];
                        fs.appendFileSync(outFile, `\n${procLine[0]};${procLine[1]};${res.value}`);
                    } else {
                        toRepeat.push(processing[i]);
                    }
                }

                try {
                    nonce = await web3.eth.getTransactionCount(sourceAddress);
                } catch (e) {
                    console.error('can not get nonce');
                }
                promises = [];
                processing = [];
                count = 0;
                console.error(`...sleeping ${batchDelay} sec`);
                await sleep(batchDelay * 1000); // wait N secs between batches
            }
        }

        if (toRepeat.length) {
            workArray = toRepeat;
            console.log(`Trying to repeat ${toRepeat.length} TXs`);
            await sleep(10000); // wait 10 secs before retry
        } else {
            finished = true;
        }
    }
})();