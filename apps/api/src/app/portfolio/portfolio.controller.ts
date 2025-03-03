import { AccessService } from '@ghostfolio/api/app/access/access.service';
import { UserService } from '@ghostfolio/api/app/user/user.service';
import {
  hasNotDefinedValuesInObject,
  nullifyValuesInObject
} from '@ghostfolio/api/helper/object.helper';
import { RedactValuesInResponseInterceptor } from '@ghostfolio/api/interceptors/redact-values-in-response.interceptor';
import { TransformDataSourceInRequestInterceptor } from '@ghostfolio/api/interceptors/transform-data-source-in-request.interceptor';
import { TransformDataSourceInResponseInterceptor } from '@ghostfolio/api/interceptors/transform-data-source-in-response.interceptor';
import { ApiService } from '@ghostfolio/api/services/api/api.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration.service';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data.service';
import { parseDate } from '@ghostfolio/common/helper';
import {
  PortfolioDetails,
  PortfolioInvestments,
  PortfolioPerformanceResponse,
  PortfolioPublicDetails,
  PortfolioReport
} from '@ghostfolio/common/interfaces';
import { InvestmentItem } from '@ghostfolio/common/interfaces/investment-item.interface';
import type {
  DateRange,
  GroupBy,
  RequestWithUser
} from '@ghostfolio/common/types';
import {
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  Version
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';

import { PortfolioPositionDetail } from './interfaces/portfolio-position-detail.interface';
import { PortfolioPositions } from './interfaces/portfolio-positions.interface';
import { PortfolioService } from './portfolio.service';

@Controller('portfolio')
export class PortfolioController {
  private baseCurrency: string;

  public constructor(
    private readonly accessService: AccessService,
    private readonly apiService: ApiService,
    private readonly configurationService: ConfigurationService,
    private readonly exchangeRateDataService: ExchangeRateDataService,
    private readonly portfolioService: PortfolioService,
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly userService: UserService
  ) {
    this.baseCurrency = this.configurationService.get('BASE_CURRENCY');
  }

  @Get('details')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(RedactValuesInResponseInterceptor)
  @UseInterceptors(TransformDataSourceInResponseInterceptor)
  public async getDetails(
    @Headers('impersonation-id') impersonationId: string,
    @Query('accounts') filterByAccounts?: string,
    @Query('assetClasses') filterByAssetClasses?: string,
    @Query('range') range?: DateRange,
    @Query('tags') filterByTags?: string
  ): Promise<PortfolioDetails & { hasError: boolean }> {
    let hasError = false;

    const filters = this.apiService.buildFiltersFromQueryParams({
      filterByAccounts,
      filterByAssetClasses,
      filterByTags
    });

    const {
      accounts,
      filteredValueInBaseCurrency,
      filteredValueInPercentage,
      hasErrors,
      holdings,
      summary,
      totalValueInBaseCurrency
    } = await this.portfolioService.getDetails({
      filters,
      impersonationId,
      dateRange: range,
      userId: this.request.user.id
    });

    if (hasErrors || hasNotDefinedValuesInObject(holdings)) {
      hasError = true;
    }

    let portfolioSummary = summary;

    if (
      impersonationId ||
      this.userService.isRestrictedView(this.request.user)
    ) {
      const totalInvestment = Object.values(holdings)
        .map((portfolioPosition) => {
          return portfolioPosition.investment;
        })
        .reduce((a, b) => a + b, 0);

      const totalValue = Object.values(holdings)
        .map((portfolioPosition) => {
          return this.exchangeRateDataService.toCurrency(
            portfolioPosition.quantity * portfolioPosition.marketPrice,
            portfolioPosition.currency,
            this.request.user.Settings.settings.baseCurrency
          );
        })
        .reduce((a, b) => a + b, 0);

      for (const [symbol, portfolioPosition] of Object.entries(holdings)) {
        portfolioPosition.grossPerformance = null;
        portfolioPosition.investment =
          portfolioPosition.investment / totalInvestment;
        portfolioPosition.netPerformance = null;
        portfolioPosition.quantity = null;
        portfolioPosition.value = portfolioPosition.value / totalValue;
      }

      for (const [name, { current, original }] of Object.entries(accounts)) {
        accounts[name].current = current / totalValue;
        accounts[name].original = original / totalInvestment;
      }

      portfolioSummary = nullifyValuesInObject(summary, [
        'cash',
        'committedFunds',
        'currentGrossPerformance',
        'currentNetPerformance',
        'currentValue',
        'dividend',
        'emergencyFund',
        'excludedAccountsAndActivities',
        'fees',
        'items',
        'netWorth',
        'totalBuy',
        'totalSell'
      ]);
    }

    let hasDetails = true;
    if (this.configurationService.get('ENABLE_FEATURE_SUBSCRIPTION')) {
      hasDetails = this.request.user.subscription.type === 'Premium';
    }

    for (const [symbol, portfolioPosition] of Object.entries(holdings)) {
      holdings[symbol] = {
        ...portfolioPosition,
        assetClass: hasDetails ? portfolioPosition.assetClass : undefined,
        assetSubClass: hasDetails ? portfolioPosition.assetSubClass : undefined,
        countries: hasDetails ? portfolioPosition.countries : [],
        currency: hasDetails ? portfolioPosition.currency : undefined,
        markets: hasDetails ? portfolioPosition.markets : undefined,
        sectors: hasDetails ? portfolioPosition.sectors : []
      };
    }

    return {
      accounts,
      filteredValueInBaseCurrency,
      filteredValueInPercentage,
      hasError,
      holdings,
      totalValueInBaseCurrency,
      summary: hasDetails ? portfolioSummary : undefined
    };
  }

  @Get('investments')
  @UseGuards(AuthGuard('jwt'))
  public async getInvestments(
    @Headers('impersonation-id') impersonationId: string,
    @Query('groupBy') groupBy?: GroupBy
  ): Promise<PortfolioInvestments> {
    if (
      this.configurationService.get('ENABLE_FEATURE_SUBSCRIPTION') &&
      this.request.user.subscription.type === 'Basic'
    ) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }

    let investments: InvestmentItem[];

    if (groupBy === 'month') {
      investments = await this.portfolioService.getInvestments(
        impersonationId,
        'month'
      );
    } else {
      investments = await this.portfolioService.getInvestments(impersonationId);
    }

    if (
      impersonationId ||
      this.userService.isRestrictedView(this.request.user)
    ) {
      const maxInvestment = investments.reduce(
        (investment, item) => Math.max(investment, item.investment),
        1
      );

      investments = investments.map((item) => ({
        date: item.date,
        investment: item.investment / maxInvestment
      }));
    }

    return { firstOrderDate: parseDate(investments[0]?.date), investments };
  }

  @Get('performance')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(TransformDataSourceInResponseInterceptor)
  @Version('2')
  public async getPerformanceV2(
    @Headers('impersonation-id') impersonationId: string,
    @Query('range') dateRange
  ): Promise<PortfolioPerformanceResponse> {
    const performanceInformation = await this.portfolioService.getPerformanceV2(
      {
        dateRange,
        impersonationId
      }
    );

    if (
      impersonationId ||
      this.request.user.Settings.settings.viewMode === 'ZEN' ||
      this.userService.isRestrictedView(this.request.user)
    ) {
      performanceInformation.performance = nullifyValuesInObject(
        performanceInformation.performance,
        ['currentGrossPerformance', 'currentNetPerformance', 'currentValue']
      );
    }

    return performanceInformation;
  }

  @Get('positions')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(TransformDataSourceInResponseInterceptor)
  public async getPositions(
    @Headers('impersonation-id') impersonationId: string,
    @Query('range') range
  ): Promise<PortfolioPositions> {
    const result = await this.portfolioService.getPositions(
      impersonationId,
      range
    );

    if (
      impersonationId ||
      this.userService.isRestrictedView(this.request.user)
    ) {
      result.positions = result.positions.map((position) => {
        return nullifyValuesInObject(position, [
          'grossPerformance',
          'investment',
          'netPerformance',
          'quantity'
        ]);
      });
    }

    return result;
  }

  @Get('public/:accessId')
  public async getPublic(
    @Param('accessId') accessId
  ): Promise<PortfolioPublicDetails> {
    const access = await this.accessService.access({ id: accessId });
    const user = await this.userService.user({
      id: access.userId
    });

    if (!access) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.NOT_FOUND),
        StatusCodes.NOT_FOUND
      );
    }

    let hasDetails = true;
    if (this.configurationService.get('ENABLE_FEATURE_SUBSCRIPTION')) {
      hasDetails = user.subscription.type === 'Premium';
    }

    const { holdings } = await this.portfolioService.getDetails({
      dateRange: 'max',
      filters: [{ id: 'EQUITY', type: 'ASSET_CLASS' }],
      impersonationId: access.userId,
      userId: access.userId
    });

    const portfolioPublicDetails: PortfolioPublicDetails = {
      hasDetails,
      alias: access.alias,
      holdings: {}
    };

    const totalValue = Object.values(holdings)
      .map((portfolioPosition) => {
        return this.exchangeRateDataService.toCurrency(
          portfolioPosition.quantity * portfolioPosition.marketPrice,
          portfolioPosition.currency,
          this.request.user?.Settings?.settings.baseCurrency ??
            this.baseCurrency
        );
      })
      .reduce((a, b) => a + b, 0);

    for (const [symbol, portfolioPosition] of Object.entries(holdings)) {
      portfolioPublicDetails.holdings[symbol] = {
        allocationCurrent: portfolioPosition.value / totalValue,
        countries: hasDetails ? portfolioPosition.countries : [],
        currency: hasDetails ? portfolioPosition.currency : undefined,
        markets: hasDetails ? portfolioPosition.markets : undefined,
        name: portfolioPosition.name,
        netPerformancePercent: portfolioPosition.netPerformancePercent,
        sectors: hasDetails ? portfolioPosition.sectors : [],
        symbol: portfolioPosition.symbol,
        url: portfolioPosition.url,
        value: portfolioPosition.value / totalValue
      };
    }

    return portfolioPublicDetails;
  }

  @Get('position/:dataSource/:symbol')
  @UseInterceptors(TransformDataSourceInRequestInterceptor)
  @UseInterceptors(TransformDataSourceInResponseInterceptor)
  @UseGuards(AuthGuard('jwt'))
  public async getPosition(
    @Headers('impersonation-id') impersonationId: string,
    @Param('dataSource') dataSource,
    @Param('symbol') symbol
  ): Promise<PortfolioPositionDetail> {
    let position = await this.portfolioService.getPosition(
      dataSource,
      impersonationId,
      symbol
    );

    if (position) {
      if (
        impersonationId ||
        this.userService.isRestrictedView(this.request.user)
      ) {
        position = nullifyValuesInObject(position, [
          'grossPerformance',
          'investment',
          'netPerformance',
          'orders',
          'quantity',
          'value'
        ]);
      }

      return position;
    }

    throw new HttpException(
      getReasonPhrase(StatusCodes.NOT_FOUND),
      StatusCodes.NOT_FOUND
    );
  }

  @Get('report')
  @UseGuards(AuthGuard('jwt'))
  public async getReport(
    @Headers('impersonation-id') impersonationId: string
  ): Promise<PortfolioReport> {
    if (
      this.configurationService.get('ENABLE_FEATURE_SUBSCRIPTION') &&
      this.request.user.subscription.type === 'Basic'
    ) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }

    return await this.portfolioService.getReport(impersonationId);
  }
}
