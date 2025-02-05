import React, { useEffect, useState } from 'react'
import { connect, ConnectedProps } from 'react-redux'
import { bindActionCreators, Dispatch } from 'redux'

import { BSPairType, CoinType, WalletOptionsType } from '@core/types'
import DataError from 'components/DataError'
import { actions, selectors } from 'data'
import { RootState } from 'data/rootReducer'

import { getData } from './selectors'
import Success from './template.success'

const AddCardCheckoutDotCom = (props: Props) => {
  const [isError, setError] = useState(false)

  const handlePostMessage = async ({
    data
  }: {
    data: {
      action: 'ADD_CARD' | 'CHANGE_BILLING_ADDRESS'
      provider: 'CHECKOUTDOTCOM'
      status: 'ERROR' | 'SUCCESS'
      token?: string
    }
  }) => {
    if (data.provider !== 'CHECKOUTDOTCOM') return

    if (data.action === 'CHANGE_BILLING_ADDRESS') {
      props.buySellActions.setStep({ step: 'BILLING_ADDRESS' })
    }

    if (data.action === 'ADD_CARD') {
      if (data.status === 'ERROR') {
        setError(true)
      }

      if (data.status === 'SUCCESS') {
        const paymentMethodTokens = props.checkoutDotComAccountCodes?.reduce((prev, curr) => {
          if (!data.token) return prev

          return {
            ...prev,
            [curr]: data.token
          }
        }, {})

        if (!paymentMethodTokens) throw new Error('No payment method tokens')

        props.buySellActions.registerCard({ paymentMethodTokens })
      }
    }
  }

  useEffect(() => {
    window.addEventListener('message', handlePostMessage, false)

    return () => window.removeEventListener('message', handlePostMessage, false)
  })

  if (isError) {
    return <DataError />
  }

  return props.data.cata({
    Failure: (e) => (
      <DataError message={{ message: e }} onClick={props.buySellActions.fetchPaymentMethods} />
    ),
    Loading: () => null,
    NotAsked: () => null,
    Success: (val) => (
      <Success
        {...props}
        {...val}
        domain={`${props.domains.walletHelper}/wallet-helper/checkoutdotcom/#/add-card/${props.checkoutDotComApiKey}`}
      />
    )
  })
}

const mapStateToProps = (state: RootState) => ({
  checkoutDotComAccountCodes: selectors.components.buySell.getCheckoutAccountCodes(state),
  checkoutDotComApiKey: selectors.components.buySell.getCheckoutApiKey(state),
  countryCode: selectors.core.settings.getCountryCode(state).getOrElse(null),
  data: getData(state),
  domains: selectors.core.walletOptions.getDomains(state).getOrElse({
    walletHelper: 'https://wallet-helper.blockchain.com'
  } as WalletOptionsType['domains']),
  fiatCurrency: selectors.components.buySell.getFiatCurrency(state) || 'USD'
})

const mapDispatchToProps = (dispatch: Dispatch) => ({
  buySellActions: bindActionCreators(actions.components.buySell, dispatch)
})

const connector = connect(mapStateToProps, mapDispatchToProps)

type OwnProps = {
  cryptoCurrency?: CoinType
  handleClose: () => void
  pair: BSPairType
}

export type SuccessStateType = ReturnType<typeof getData>['data']

export type Props = OwnProps & ConnectedProps<typeof connector>

export default connector(AddCardCheckoutDotCom)
