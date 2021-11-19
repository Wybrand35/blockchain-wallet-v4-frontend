import WalletConnect from '@walletconnect/client'
import { eventChannel } from 'redux-saga'
import { call, cancel, cancelled, fork, put, select, take } from 'redux-saga/effects'

import { coreSelectors } from 'blockchain-wallet-v4/src'
import { actions, selectors } from 'data'
import {
  AddNewDappFormType,
  InitWalletConnectPayload,
  RequestMethodType,
  WalletConnectStep
} from 'data/components/walletConnect/types'
import { ModalName } from 'data/modals/types'

import { BC_CLIENT_METADATA, WC_ADD_DAPP_FORM, WC_STORAGE_KEY } from './model'
import * as S from './selectors'
import { actions as A } from './slice'

const logError = (e) => {
  console.error('WC Error: ', e)
}

export default ({ coreSagas }) => {
  let rpc

  // adds a new dapp connection to local storage
  const addDappToLocalStorage = function* ({ clientId, sessionDetails, uri }) {
    // get existing dapp connections
    const dappList = yield select(S.getAuthorizedDappsList)
    // check if dapp was already stored
    const matchIndex = dappList.findIndex(
      (dapp) =>
        JSON.stringify(dapp.sessionDetails.peerMeta) === JSON.stringify(sessionDetails.peerMeta)
    )

    if (matchIndex !== -1) {
      // update exist dapp if match found
      dappList[matchIndex] = { clientId, sessionDetails, uri }
    } else {
      // push new dapp to list
      dappList.push({ clientId, sessionDetails, uri })
    }

    // write list back to local storage
    localStorage.setItem(WC_STORAGE_KEY, JSON.stringify(dappList))
  }

  // removes a previously stored dapp from local storage
  const removeDappFromLocalStorage = function* ({ sessionDetails }) {
    // get existing dapp connections
    const dappList = yield select(S.getAuthorizedDappsList)
    // remove desired dapp and restore
    localStorage.setItem(
      WC_STORAGE_KEY,
      JSON.stringify(
        dappList.filter(
          (dapp) =>
            JSON.stringify(dapp.sessionDetails.peerMeta) !== JSON.stringify(sessionDetails.peerMeta)
        )
      )
    )
  }

  // session call request from dapp
  const handleSessionCallRequest = function* ({
    payload
  }: ReturnType<typeof A.handleSessionCallRequest>) {
    switch (true) {
      case payload.data.method === RequestMethodType.ETH_SEND_TX:
        return yield put(
          A.setStep({
            data: payload.data,
            error: payload.error,
            name: WalletConnectStep.APPROVE_TRANSACTION
          })
        )
      default:
        break
    }
  }

  // session failed, ended by dapp or rejected by user
  const handleSessionDisconnect = function* ({
    payload
  }: ReturnType<typeof A.handleSessionDisconnect>) {
    yield put(
      A.setStep({
        data: payload.data,
        error: payload.error,
        name: WalletConnectStep.DISCONNECTION_NOTICE
      })
    )
  }

  // session request from dapp
  const handleSessionRequest = function* ({ payload }: ReturnType<typeof A.handleSessionRequest>) {
    // show user session accept/reject screen
    yield put(
      A.setStep({
        data: payload.data.params[0],
        error: payload.error,
        name: WalletConnectStep.AUTHORIZE_CONNECTION
      })
    )
  }

  const createRpcListenerChannels = function () {
    return eventChannel((emit) => {
      // subscribe to session requests
      rpc.on('session_request', (error, data) => {
        emit(A.handleSessionRequest({ data, error }))
      })

      // subscribe to call requests
      rpc.on('call_request', (error, data) => {
        emit(A.handleSessionCallRequest({ data, error }))
      })

      // subscribe to disconnects
      rpc.on('disconnect', (error, data) => {
        // TODO: remove from localStorage?
        emit(A.handleSessionDisconnect({ data, error }))
      })

      return () => {
        rpc.killSession()
      }
    })
  }

  const startRpcConnection = function* ({ sessionDetails, uri }: InitWalletConnectPayload) {
    let channel
    try {
      // TODO: evaluate the need for this HACK!?
      localStorage.removeItem('walletconnect')

      // init rpc
      rpc = new WalletConnect({
        clientMeta: BC_CLIENT_METADATA,
        uri
      })

      // check for existing client id
      if (sessionDetails) {
        const dappList = yield select(S.getAuthorizedDappsList)
        const matchIndex = dappList.findIndex(
          (dapp) =>
            JSON.stringify(dapp.sessionDetails.peerMeta) === JSON.stringify(sessionDetails.peerMeta)
        )
        if (matchIndex !== -1) {
          rpc.client = dappList[matchIndex].clientId
        }
      }

      // start listeners for rpc messages
      channel = yield call(createRpcListenerChannels)

      while (true) {
        // message from rpc, forward action
        const action = yield take(channel)
        yield put(action)
      }
    } catch (e) {
      logError(e)
    } finally {
      if (yield cancelled()) {
        channel.close()
        rpc.killSession()
      }
    }
  }

  const launchDappConnection = function* ({ payload }: ReturnType<typeof A.launchDappConnection>) {
    try {
      const { sessionDetails, uri } = payload

      yield put(A.setSessionDetails(sessionDetails))
      yield put(A.setStep({ name: WalletConnectStep.SESSION_DASHBOARD }))
      yield put(
        actions.modals.showModal(ModalName.WALLET_CONNECT_MODAL, { origin: 'WalletConnect' })
      )

      // if rpc connection exists and it matches the requested dapp to be launched
      if (!rpc || JSON.stringify(sessionDetails.peerMeta) !== JSON.stringify(rpc.peerMeta)) {
        yield put(A.initWalletConnect({ sessionDetails, uri }))
      }
    } catch (e) {
      logError(e)
    }
  }

  const removeDappConnection = function* ({ payload }: ReturnType<typeof A.removeDappConnection>) {
    try {
      const { sessionDetails } = payload
      // if rpc connection exists and it matches the dapp to be removed
      if (rpc && JSON.stringify(sessionDetails.peerMeta) === JSON.stringify(rpc.peerMeta)) {
        // kill session and notify dapp of disconnect
        rpc.killSession()
        // reset internal rpc to null
        rpc = null
      }
      // remove from local storage
      yield call(removeDappFromLocalStorage, { sessionDetails })
    } catch (e) {
      logError(e)
    }
  }

  const initWalletConnect = function* ({ payload }: ReturnType<typeof A.initWalletConnect>) {
    try {
      const { sessionDetails, uri } = payload
      // start rpc connection and listeners
      const rpcTask = yield fork(startRpcConnection, { sessionDetails, uri })
      // wait for a disconnect event
      yield take(A.handleSessionDisconnect.type)
      // disconnect received, kill rpc
      yield cancel(rpcTask)
    } catch (e) {
      logError(e)
    }
  }

  const respondToSessionRequest = function* ({
    payload
  }: ReturnType<typeof A.respondToSessionRequest>) {
    const { action, sessionDetails, uri } = payload

    try {
      yield put(A.setStep({ name: WalletConnectStep.LOADING }))

      if (action === 'APPROVE') {
        // store dapp details on state
        yield put(A.setSessionDetails(sessionDetails))

        // TODO: really pulling clientId from rpc...?
        // store dapp connection in local storage
        yield call(addDappToLocalStorage, { clientId: rpc.clientId, sessionDetails, uri })

        const ethAccount = (yield select(coreSelectors.kvStore.eth.getContext)).getOrFail(
          'Failed to extract ETH account.'
        )
        rpc.approveSession({
          accounts: [ethAccount],
          chainId: 1 // ETH mainnet
        })

        // connection made, show user wallet connect dashboard
        yield put(
          A.setStep({
            name: WalletConnectStep.SESSION_DASHBOARD
          })
        )
      } else {
        // user rejected session, state update handled by handleSessionDisconnect
        rpc.rejectSession({ message: 'Connection rejected by user.' })
      }
    } catch (e) {
      logError(e)
    }
  }

  const respondToTxSendRequest = function* ({
    payload
  }: ReturnType<typeof A.respondToTxSendRequest>) {
    try {
      yield put(A.setStep({ name: WalletConnectStep.LOADING }))

      if (payload.action === 'APPROVE') {
        // TODO
      } else {
        // user rejected transaction
        rpc.rejectRequest({
          error: { message: 'Transaction rejected by user.' },
          id: payload.requestDetails.id
        })

        yield put(
          A.setStep({
            name: WalletConnectStep.SESSION_DASHBOARD
          })
        )
      }
    } catch (e) {
      logError(e)
    }
  }

  const addNewDappConnection = function* ({ payload }: ReturnType<typeof A.addNewDappConnection>) {
    try {
      yield put(A.setStep({ name: WalletConnectStep.LOADING }))
      const { newConnectionString } = selectors.form.getFormValues(WC_ADD_DAPP_FORM)(
        yield select()
      ) as AddNewDappFormType
      yield put(A.initWalletConnect({ uri: newConnectionString }))
    } catch (e) {
      logError(e)
    }
  }

  return {
    addNewDappConnection,
    handleSessionCallRequest,
    handleSessionDisconnect,
    handleSessionRequest,
    initWalletConnect,
    launchDappConnection,
    removeDappConnection,
    respondToSessionRequest,
    respondToTxSendRequest
  }
}
